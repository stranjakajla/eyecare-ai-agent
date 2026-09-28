// SimulationRunner.js
// Pokreće tick loop i simulira događaje (aktivnost/pauza/svjetlo/sat).
// + šalje snapshot u backend (http://localhost:4000/api/update) da UI može prikazivati LIVE.
// Koristi ugrađeni fetch (Node 18+) – nema potrebe za node-fetch.

if (typeof globalThis.fetch !== "function") {
  console.error("Potreban je Node 18+ (fetch). Trenutna verzija:", process.version);
  process.exit(1);
}

const EyeCareAgent = require("./EyeCareAgent");

// Helper: sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: random choice with weights
function weightedChoice(options) {
  // options: [{ key: "nature", w: 0.3 }, ...]
  const sum = options.reduce((a, o) => a + o.w, 0);
  const r = Math.random() * sum;
  let acc = 0;
  for (const o of options) {
    acc += o.w;
    if (r <= acc) return o.key;
  }
  return options[options.length - 1].key;
}

class SimulationRunner {
  constructor({
    tickSeconds = 10,    // jedan tick svakih 10 s = 5 min simulacije – strain raste po satima
    startHour = 20,      // početni sat u simulaciji
    lightMode = "mixed", // "good" | "poor" | "mixed"
    backendUrl = "http://localhost:4000/api/update", // gdje šaljemo snapshot
  } = {}) {
    this.agent = new EyeCareAgent();

    this.tickSeconds = tickSeconds;
    this.hour = startHour;
    this.minuteOfHour = 0;

    this.lightMode = lightMode;
    this.backendUrl = backendUrl;

    // Simulirano stanje korisnika
    this.user = {
      onBreak: false,
      activeMinutesSinceBreak: 0,
      breakTicksLeft: 0,   // 15 min pauza = 3 ticka
      cooldownTicksLeft: 0, // 30 min cooldown = 6 ticka (bez notifikacija)
    };

    this.running = false;
  }

  // simuliraj osvjetljenje
  getLight() {
    if (this.lightMode === "good") return "good";
    if (this.lightMode === "poor") return "poor";
    return Math.random() < 0.25 ? "poor" : "good"; // 25% loše
  }

  // simuliraj "protok vremena" u minuti
  advanceTime(simMinutes = 5) {
    this.minuteOfHour += simMinutes;
    while (this.minuteOfHour >= 60) {
      this.minuteOfHour -= 60;
      this.hour += 1;
      if (this.hour >= 24) this.hour = 0;
    }
  }

  // simuliraj da li korisnik prihvati ili ignoriše intervenciju
  // (kasnije će ovo dolaziti iz UI-ja preko /api/respond, ali za demo je ok simulacija)
  simulateUserResponse(allowedOptions) {
    // allowedOptions: npr ["ignore","nature","exercises"]
    const p = this.agent.preferences;

    const choice = weightedChoice([
      { key: "ignore", w: p.ignore },
      { key: "nature", w: p.nature },
      { key: "exercises", w: p.exercises },
    ]);

    if (!allowedOptions.includes(choice)) {
      if (allowedOptions.includes("exercises")) return Math.random() < 0.7 ? "exercises" : "ignore";
      return "ignore";
    }
    return choice;
  }

  applyEffectOfResponse(response) {
    // efekat na “pauzu” i eye strain
    if (response === "ignore" || response === "NONE") {
      this.user.onBreak = false;
      return;
    }

    // Strain pada SAMO ovdje kad korisnik klikne Priroda (-25) ili Vježbe (-30)
    this.user.onBreak = true;
    this.user.breakTicksLeft = 3; // 15 min pauze (bez -3 po ticku)
    this.user.activeMinutesSinceBreak = 0;

    if (response === "nature") {
      this.agent.eyeStrainLevel = Math.max(0, this.agent.eyeStrainLevel - 25);
    } else if (response === "exercises") {
      this.agent.eyeStrainLevel = Math.max(0, this.agent.eyeStrainLevel - 30);
    }
  }

  // napravi snapshot trenutnog stanja (za dashboard)
  buildSnapshot({ light, output, response, activeMinutes }) {
    const timeStr = `${String(this.hour).padStart(2, "0")}:${String(this.minuteOfHour).padStart(2, "0")}`;

    // pendingOffer: samo kad agent nudi opcije
    const pendingOffer =
      output && output.options && output.options.length > 0
        ? {
            message: output.message ?? "Would you like a break?",
            options: output.options,
          }
        : null;

    // malo uredimo history za UI
    const history = (this.agent.history ?? []).slice(-30).map((h) => ({
      time: h.time ?? timeStr,
      eyeStrainLevel: h.eyeStrainLevel ?? this.agent.eyeStrainLevel,
      action: h.action,
      userResponse: h.userResponse ?? null,
      light: h.light ?? null,
    }));

    return {
      time: timeStr,
      hour: this.hour,
      minute: this.minuteOfHour,
      activeMinutes,
      onBreak: this.user.onBreak,
      light,
      eyeStrainLevel: this.agent.eyeStrainLevel,
      preferences: this.agent.preferences,
      hourStats: this.agent.hourStats ?? {},
      pendingOffer,
      history,
    };
  }

  // šalje stanje u backend da UI može prikazivati LIVE
  async pushStateToBackend(state) {
    try {
      await fetch(this.backendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
    } catch (e) {
      // ako backend nije upaljen – ignoriši da ne ruši runner
    }
  }

  async start({ steps = 40 } = {}) {
    this.running = true;

    console.log("=== EyeCare Simulation Runner START ===");
    console.log(`tickSeconds=${this.tickSeconds}, steps=${steps}`);
    console.log("--------------------------------------");

    for (let i = 0; i < steps && this.running; i++) {
      // 1) pauza 15 min = 3 ticka (prema specifikaciji); tijekom pauze strain -3 po ticku
      if (this.user.breakTicksLeft > 0) {
        this.user.onBreak = true;
        this.user.breakTicksLeft -= 1;
        if (this.user.breakTicksLeft === 0) {
          this.user.onBreak = false;
          this.user.cooldownTicksLeft = 6; // 30 min cooldown – bez novih notifikacija
        }
      }

      const activeMinutes = this.user.onBreak ? 0 : 5; // 5 min po ticku, +1 strain (spec)
      if (!this.user.onBreak) this.user.activeMinutesSinceBreak += activeMinutes;

      // 2) simuliraj kontekst
      const light = this.getLight();

      // 3) tick input
      const input = {
        activeMinutes,
        onBreak: this.user.onBreak,
        hour: this.hour,
        light,
        lastResponse: "NONE",
      };

      // 4) agent tick
      let output = this.agent.tick(input);

      // 4b) tijekom pauze (15 min) i cooldowna (30 min nakon pauze) ne nudi ponovo – da korisnik ima “pauzu” nakon vježbi
      if (this.user.breakTicksLeft > 0) {
        if (output && output.options && output.options.length > 0) {
          output = { message: "Agent decided not to intervene.", options: [] };
        }
      }
      if (this.user.cooldownTicksLeft > 0) {
        this.user.cooldownTicksLeft -= 1;
        if (output && output.options && output.options.length > 0) {
          output = { message: "Agent decided not to intervene.", options: [] };
        }
      }

      // 5) ako agent nudi opcije: prvo pošalji stanje u backend (da UI pokaže dugmad), pa čekaj tvoj klik
      let response = "NONE";
      if (output && output.options && output.options.length > 0) {
        const allowed = ["ignore", ...output.options];
        const snapshotForOffer = this.buildSnapshot({ light, output, response: "NONE", activeMinutes });
        await this.pushStateToBackend(snapshotForOffer);

        // Samo korisnik bira – nikad simulacija; ako ne klikne u roku, računamo kao "ignore"
        const userResponse = await this.waitForUserResponse();
        response = userResponse && allowed.includes(userResponse) ? userResponse : "ignore";

        this.agent.learn(this.hour, response);
        this.applyEffectOfResponse(response);

        const last = this.agent.history[this.agent.history.length - 1];
        if (last) last.userResponse = response;
      } else {
        const last = this.agent.history[this.agent.history.length - 1];
        if (last) last.userResponse = "NO_WORK";
      }

      // 6) ispisi stanje
      console.log(
        `[${i + 1}] time=${String(this.hour).padStart(2, "0")}:${String(this.minuteOfHour).padStart(2, "0")} ` +
          `activeMin=${activeMinutes} light=${light} strain=${this.agent.eyeStrainLevel} ` +
          `action=${this.agent.history[this.agent.history.length - 1]?.action} response=${response}`
      );
      console.log(
        `    prefs: nature=${this.agent.preferences.nature.toFixed(2)} exercises=${this.agent.preferences.exercises.toFixed(2)} ignore=${this.agent.preferences.ignore.toFixed(2)}`
      );

      // 7) push snapshot u backend (za UI)
      const snapshot = this.buildSnapshot({ light, output, response, activeMinutes });
      await this.pushStateToBackend(snapshot);

      // 8) protok vremena
      this.advanceTime(5);

      // 9) sleep
      await sleep(this.tickSeconds * 1000);
    }

    console.log("--------------------------------------");
    console.log("=== EyeCare Simulation Runner END ===");
  }

  stop() {
    this.running = false;
  }

  // Backend base URL (za /api/consume-response)
  getConsumeResponseUrl() {
    return this.backendUrl.replace(/\/api\/update\/?$/, "") + "/api/consume-response";
  }

  // Čeka odgovor korisnika s dashboarda (do 20 s) – da strain može dalje rasti ako ne klikneš
  async waitForUserResponse() {
    const url = this.getConsumeResponseUrl();
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (data && data.response) return data.response;
      } catch (e) {}
    }
    return null;
  }
}

// Ako pokrećeš direktno: node agent/SimulationRunner.js
if (require.main === module) {
  const runner = new SimulationRunner({
    tickSeconds: 10, // jedan tick = 5 min simulacije, svakih 10 s realno – strain raste "po satima" sim
    startHour: 20,
    lightMode: "mixed",
  });

  const STEPS = 500;
  console.log(`Runner: 1 tick = 5 min simulacije, svakih 10 s. Samo tvoj klik (Priroda/Vježbe/Ignore) – nema automatskog odabira.`);
  runner.start({ steps: STEPS }).catch((err) => console.error(err));
}

module.exports = SimulationRunner;
