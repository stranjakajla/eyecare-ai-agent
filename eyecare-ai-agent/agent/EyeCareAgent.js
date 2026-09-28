// EyeCareAgent.js
// Glavni agent koji implementira Sense–Think–Act–Learn ciklus.
// Dorada 2: think() koristi naučene parametre (adaptivni pragovi); learn() persistira u JSON.

const fs = require("fs");
const path = require("path");

const DEFAULT_STATE_PATH = path.join(__dirname, "agent-state.json");

class EyeCareAgent {
  constructor({ statePath = DEFAULT_STATE_PATH } = {}) {
    this.statePath = statePath;

    this.eyeStrainLevel = 0;

    this.preferences = {
      nature: 0.33,
      exercises: 0.33,
      ignore: 0.34,
    };

    this.hourStats = {};

    // Brojač tikova za usporen rast straina (samo svaki 2. tick +1 za rad)
    this.strainTickCounter = 0;

    // Adaptivni pragovi (naučeni iz feedbacka) – koriste se u think()
    this.thresholdNoWork = 40;
    this.thresholdOffer = 70;

    this.history = [];

    this.loadState();
  }

  // =========================
  // Persistiranje naučenih parametara (Dorada 2b)
  // =========================
  loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        if (data.preferences) this.preferences = { ...this.preferences, ...data.preferences };
        if (data.hourStats) this.hourStats = { ...this.hourStats, ...data.hourStats };
        if (typeof data.thresholdNoWork === "number") this.thresholdNoWork = data.thresholdNoWork;
        if (typeof data.thresholdOffer === "number") this.thresholdOffer = data.thresholdOffer;
      }
    } catch (e) {
      // ignoriraj greške čitanja (npr. prvi pokret)
    }
  }

  saveState() {
    try {
      const data = {
        preferences: this.preferences,
        hourStats: this.hourStats,
        thresholdNoWork: this.thresholdNoWork,
        thresholdOffer: this.thresholdOffer,
      };
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      // ne ruši agent ako nema pisanja
    }
  }

  // Efektivni pragovi za dani sat: ako često ignorišeš u tom satu -> viši prag (manje te uznemirava)
  getEffectiveThresholds(hour) {
    let noWork = this.thresholdNoWork;
    let offer = this.thresholdOffer;

    const stats = this.hourStats[hour];
    if (stats && (stats.ignored + stats.accepted) > 0) {
      const ignored = stats.ignored || 0;
      const accepted = stats.accepted || 0;
      const diff = ignored - accepted;
      // Ako korisnik često ignoriše u ovom satu -> PODIŽI prag (ne uznemirava u tim satima)
      const offset = Math.min(20, Math.max(0, diff * 2));
      noWork = Math.max(20, Math.min(55, noWork + offset));
      offer = Math.max(35, Math.min(90, offer + offset));
    }

    return { noWork, offer };
  }

  // =========================
  // SENSE – opažanje okoline
  // =========================
  sense(input) {
    return {
      activeMinutes: input.activeMinutes || 0,
      onBreak: input.onBreak || false,
      hour: input.hour,
      light: input.light || "good",
      lastResponse: input.lastResponse || "NONE",
    };
  }

  // =========================
  // THINK – donošenje odluke (koristi naučene parametre: pragovi + hourStats)
  // =========================
  think(perception) {
    // Povećanja: +1 na svakih 10 min rada (svaki 2. tick), +1 loše svjetlo, +2 noć. Smanjenje SAMO kad korisnik klikne (nature -25, exercises -30).
    if (!perception.onBreak) {
      this.strainTickCounter = (this.strainTickCounter || 0) + 1;
      if (perception.activeMinutes > 0 && this.strainTickCounter % 2 === 0) this.eyeStrainLevel += 1;
      if (perception.light === "poor") this.eyeStrainLevel += 1;
      if (perception.hour >= 21 || perception.hour <= 6) this.eyeStrainLevel += 2;
    }

    this.eyeStrainLevel = Math.max(0, Math.min(100, this.eyeStrainLevel));

    // >= 70 uvijek samo vježbe (STRONG_INTERVENTION)
    if (this.eyeStrainLevel >= 70) return "STRONG_INTERVENTION";

    const { noWork, offer } = this.getEffectiveThresholds(perception.hour);
    if (this.eyeStrainLevel < noWork) return "NO_WORK";
    if (this.eyeStrainLevel < offer) return "OFFER_BREAK";
    return "STRONG_INTERVENTION";
  }

  // =========================
  // ACT – izvršavanje akcije
  // =========================
  act(action) {
    if (action === "NO_WORK") {
      return { message: "Agent decided not to intervene." };
    }

    if (action === "OFFER_BREAK") {
      return {
        message: "Would you like a break in nature, short exercises, or ignore?",
        options: ["nature", "exercises", "ignore"],
      };
    }

    if (action === "STRONG_INTERVENTION") {
      return {
        message: "Naprezanje >= 70. Preporučuju se samo vježbe za oči (ili ignoriši).",
        options: ["exercises", "ignore"],
      };
    }
  }

  // =========================
  // LEARN – prilagođavanje (ažurira pragove + persistira)
  // =========================
  learn(hour, userResponse) {
    // Izabrana opcija +0.05; ostale -0.01 (ako dugo nisu birane, težina pada – dugme može postati neaktivno)
    const keys = ["nature", "exercises", "ignore"];
    keys.forEach((k) => {
      if (k === userResponse && this.preferences[k] !== undefined) {
        this.preferences[k] += 0.05;
      } else if (this.preferences[k] !== undefined) {
        this.preferences[k] = Math.max(0.05, this.preferences[k] - 0.01);
      }
    });
    const sum =
      this.preferences.nature + this.preferences.exercises + this.preferences.ignore;
    this.preferences.nature /= sum;
    this.preferences.exercises /= sum;
    this.preferences.ignore /= sum;

    if (!this.hourStats[hour]) {
      this.hourStats[hour] = { accepted: 0, ignored: 0 };
    }
    if (userResponse === "ignore") {
      this.hourStats[hour].ignored += 1;
      // Kad ignorišeš -> podigni prag da te u tim satima manje uznemirava
      this.thresholdOffer = Math.min(90, this.thresholdOffer + 1);
      this.thresholdNoWork = Math.min(55, this.thresholdNoWork + 0.5);
    } else {
      this.hourStats[hour].accepted += 1;
      this.thresholdOffer = Math.max(35, this.thresholdOffer - 0.5);
      this.thresholdNoWork = Math.max(20, this.thresholdNoWork - 0.25);
    }

    this.saveState();
  }

  // =========================
  // TICK – puni agent ciklus
  // =========================
  tick(input) {
    const perception = this.sense(input);
    const action = this.think(perception);
    const result = this.act(action);

    this.history.push({
      time: new Date().toISOString(),
      eyeStrainLevel: this.eyeStrainLevel,
      action: action,
    });

    return result;
  }
}

module.exports = EyeCareAgent;
