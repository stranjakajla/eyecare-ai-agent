# Dorade projekta EyeCare Agent – IB220317

Dokument opisuje šta je bilo prije i šta je poslije za svaku doradu, te gdje se promjena vidi u kodu (putanja/fajl/klasa/metoda). Numeracija odgovara numeraciji dorada iz uputa.

---

## 1. Premjestiti tick/scheduling logiku iz web sloja u agent sloj (Thin Web)

### Šta je bilo prije
- U **backend/server.js** bila je cijela tick/simulacijska logika:
  - Varijable: `simHour`, `simMinute`, `pendingOffer`, `agent` (instanca EyeCareAgent).
  - Funkcije: `advanceTime(simMinutes)`, `runTick({ activeMinutes, onBreak, light })` koja je zvala `agent.tick()` i ažurirala vrijeme.
  - `setInterval(..., 60*1000)` koji je svakih 60 s pozivao `runTick()` ako runner nije šaljao stanje (fallback simulacija).
  - Endpoint **POST /api/tick** koji je ručno pokretao `runTick()` s parametrima iz body-ja.
- Backend je donosio odluke (tick) i vodio simulaciju vremena kada runner nije bio aktivan.

### Šta je poslije
- Iz **backend/server.js** uklonjene su sve tick/scheduling komponente:
  - Nema više `simHour`, `simMinute`, `pendingOffer`, `advanceTime()`, `runTick()`, `setInterval()`, endpointa **POST /api/tick**, niti require/instanciranja EyeCareAgent.
- Backend sada samo:
  - Prima podatke: **POST /api/update** (runner šalje snapshot stanja).
  - Vraća stanje: **GET /api/state** (vraća `agentState` ako runner šalje, inače `{ runnerActive: false, message: "Start SimulationRunner ..." }`).
  - Prima odgovor korisnika: **POST /api/respond** (postavlja `pendingUserResponse` za runner).
  - **GET /api/consume-response** – runner uzima odgovor korisnika (vraća i briše `pendingUserResponse`).
- Tick i scheduling ostaju isključivo u agent sloju: **agent/SimulationRunner.js** (petlja u `start()`, `advanceTime()`, `agent.tick()`, `pushStateToBackend()`).

### Gdje se promjena vidi u kodu
| Šta | Putanja / fajl | Klasa / metoda / dio |
|-----|----------------|----------------------|
| Uklonjena tick/scheduling logika | **backend/server.js** | Cijeli fajl – uklonjene varijable, `advanceTime`, `runTick`, `setInterval`, POST `/api/tick`, require EyeCareAgent; ostaju `agentState`, `pendingUserResponse`, `hasRunnerState()`, POST `/api/update`, GET `/api/state`, POST `/api/respond`, GET `/api/consume-response`. |
| Tick petlja u agent sloju | **agent/SimulationRunner.js** | Klasa `SimulationRunner`: metoda **start()** (petlja), **advanceTime(simMinutes)**, **pushStateToBackend(state)**. |
| Fallback prikaz kad runner nije aktivan | **frontend/index.html** | Funkcija `render(state)` – prikaz poruke kada `state.runnerActive === false` ili nema stanja. |

---

## 2. Popraviti Learn mehanizam da stvarno utiče na odluku

### 2(a) Uključiti naučene parametre u odluku (adaptivni pragovi)

**Šta je bilo prije**
- **EyeCareAgent.learn()** je ažurirao `preferences` i `hourStats`, ali **EyeCareAgent.think()** ih nije koristio.
- Pragovi za odluku bili su hardkodirani: `40` (NO_WORK vs OFFER) i `70` (OFFER vs STRONG_INTERVENTION).

**Šta je poslije**
- U **agent/EyeCareAgent.js**:
  - Dodani su naučeni pragovi: `thresholdNoWork` (default 40) i `thresholdOffer` (default 70).
  - U **think(perception)** odluka se donosi prema **efektivnim pragovima** za dani sat: `getEffectiveThresholds(perception.hour)` vraća `{ noWork, offer }` na osnovu `hourStats` (ako je u tom satu često ignorirano, pragovi se podižu – manje intervencija).
  - U **learn(hour, userResponse)**:
    - Na "ignore": `thresholdOffer` i `thresholdNoWork` se podižu (do max 90 odnosno 55).
    - Na prihvaćanje (nature/exercises): pragovi se spuštaju (min 35 odnosno 20).
- Isti ulaz (npr. isti eyeStrainLevel) može nakon više "ignore" feedbacka dati NO_WORK umjesto OFFER_BREAK.

**Gdje se promjena vidi u kodu**
| Šta | Putanja / fajl | Klasa / metoda |
|-----|----------------|-----------------|
| Adaptivni pragovi i korištenje u odluci | **agent/EyeCareAgent.js** | Klasa `EyeCareAgent`: konstruktor (inicijalizacija `thresholdNoWork`, `thresholdOffer`), **getEffectiveThresholds(hour)** (nova metoda – offset prema `hourStats`), **think(perception)** (koristi `getEffectiveThresholds(perception.hour)` umjesto 40/70), **learn(hour, userResponse)** (ažurira `thresholdOffer` i `thresholdNoWork`). |

### 2(b) Persistirati naučene parametre (JSON fajl)

**Šta je bilo prije**
- `preferences` i `hourStats` (i eventualno drugi naučeni podaci) bili su samo u memoriji – nakon restarta aplikacije sve se gubilo.

**Šta je poslije**
- U **agent/EyeCareAgent.js**:
  - Konstruktor prima opciju `statePath` (default: `agent/agent-state.json`).
  - **loadState()** – u konstruktoru se poziva; čita JSON s diska i puni `preferences`, `hourStats`, `thresholdNoWork`, `thresholdOffer`.
  - **saveState()** – na kraju **learn()** upisuje u JSON: `preferences`, `hourStats`, `thresholdNoWork`, `thresholdOffer`.
- Naučeni parametri preživljavaju restart (datoteka `agent-state.json` u folderu agent).

**Gdje se promjena vidi u kodu**
| Šta | Putanja / fajl | Klasa / metoda |
|-----|----------------|-----------------|
| Učitavanje i spremanje stanja | **agent/EyeCareAgent.js** | Klasa `EyeCareAgent`: konstruktor (`this.statePath`, poziv `loadState()`), **loadState()** (nova metoda – fs.readFileSync, parsiranje, punjenje polja), **saveState()** (nova metoda – fs.writeFileSync), **learn()** (na kraju poziv `saveState()`). |

### 2(c) Demonstrirati da isti/sličan input daje drugu odluku nakon feedbacka

**Šta je bilo prije**
- Isti eyeStrainLevel (npr. 65) uvijek je davao istu akciju (OFFER_BREAK), bez obzira na prethodni feedback.

**Šta je poslije**
- Nakon više "ignore" odgovora:
  - **learn()** podiže `thresholdOffer` i `thresholdNoWork`, a **getEffectiveThresholds(hour)** za sat s puno ignoriranja dodatno podiže efektivne pragove.
  - Za isti eyeStrainLevel (npr. 65) **think()** sada može vratiti NO_WORK umjesto OFFER_BREAK (ako je efektivni prag za OFFER postao npr. 72).
- Suprotno: nakon više prihvaćanja (nature/exercises) pragovi se spuštaju – ista razina naprezanja ranije može davati intervenciju.
- Demonstracija u kodu: **SimulationRunner** u petlji poziva `agent.learn(this.hour, response)`; nakon nekoliko tickova s "ignore" isti ulaz u sljedećem ticku daje drugu odluku u **think()** zbog ažuriranih pragova i **getEffectiveThresholds()**.

**Gdje se promjena vidi**
- Ista logika kao u 2(a) i 2(b): **agent/EyeCareAgent.js** – **think()**, **learn()**, **getEffectiveThresholds()**, **loadState()**, **saveState()**; pokretanjem **agent/SimulationRunner.js** vidi se u konzoli kako se action mijenja s obzirom na prethodne response (npr. nakon više "ignore" za isti sat).
