const express = require("express");
const cors = require("cors");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

// Dashboard: otvori http://localhost:4000/ da vidiš frontend (isti origin = API radi)
const frontendDir = path.join(__dirname, "..", "frontend");
app.use(express.static(frontendDir));
app.get("/", (req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

// --- Thin Web: samo prima podatke i vraća stanje ---
// Tick/scheduling logika je u agent sloju (SimulationRunner.js).

let agentState = null; // puni se preko POST /api/update (snapshot iz runnera)
let pendingUserResponse = null; // odgovor s UI-ja za runner (consume-response)

function hasRunnerState() {
  return agentState && typeof agentState === "object" && Object.keys(agentState).length > 0;
}

// Runner -> backend (šalje snapshot stanja)
app.post("/api/update", (req, res) => {
  agentState = req.body || null;
  if (agentState && typeof agentState === "object") agentState.lastUpdate = Date.now();
  res.json({ ok: true });
});

// Runner uzima odgovor korisnika (što je kliknuto na dashboardu)
app.get("/api/consume-response", (req, res) => {
  const response = pendingUserResponse;
  pendingUserResponse = null;
  res.json({ response: response || null });
});

// UI state (samo vraća stanje – bez decision/tick logike)
app.get("/api/state", (req, res) => {
  if (hasRunnerState()) {
    return res.json(agentState);
  }
  return res.json({
    runnerActive: false,
    message: "Start SimulationRunner (node agent/SimulationRunner.js) to run simulation.",
  });
});

// Korisnikov odgovor (UI -> backend); backend samo ažurira state za prikaz.
// Stvarno učenje i odluke vrši agent sloj u SimulationRunneru.
app.post("/api/respond", (req, res) => {
  const { response } = req.body || {};
  if (!response) return res.status(400).json({ error: "Missing response" });

  if (hasRunnerState()) {
    pendingUserResponse = response; // runner će uzeti preko /api/consume-response
    if (Array.isArray(agentState.history) && agentState.history.length > 0) {
      agentState.history[agentState.history.length - 1].userResponse = response;
    }
    agentState.pendingOffer = null;
    return res.json({ ok: true, mode: "runner" });
  }

  return res.status(503).json({
    error: "Runner not active",
    message: "Start SimulationRunner to process responses and learn.",
  });
});

app.listen(4000, () => {
  console.log("Backend running on http://localhost:4000");
  console.log("Dashboard: otvori u browseru http://localhost:4000/");
  console.log("API: http://localhost:4000/api/state");

  // Automatski pokreni runner (agent) kao child process – sve radi iz jedne komande
  const projectRoot = path.join(__dirname, "..");
  const runner = spawn("node", ["agent/SimulationRunner.js"], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: true,
  });
  runner.on("error", (err) => console.error("Runner error:", err));
  runner.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.log("Runner exited with code", code);
  });
});
