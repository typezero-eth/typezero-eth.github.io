/*
 * TYPE ZERO – Open Source Modul Generator
 * Regelwerk, Zufallsgenerator und Prüfung
 *
 * Ein Block besteht aus Modulen von 4 x 4 x 3 m.
 *   x = Ost-West, immer 3 Module (12 m, Gebäudetiefe)
 *   y = Nord-Süd, 5, 4 oder 3 Module (Länge)
 *   z = Ebenen, immer 6 (18 m)
 *
 * Jede Anordnung, die alle Regeln erfüllt, ist ein gültiges Gebäude.
 * Dieses Programm sucht zufällig solche Anordnungen und prüft sie.
 *
 * Läuft im Browser (auch als Web Worker) und unter Node.js.
 */
'use strict';

(function (global) {

  // ---------------------------------------------------------------
  // 1. Die drei Blockgrössen und ihr Wohnungsmix
  // ---------------------------------------------------------------

  const NX = 3;   // Module Ost-West
  const NZ = 6;   // Ebenen

  const GROESSEN = {
    '3/5/6': { NY: 5, mix: { A: 4, B: 5, C: 5, D: 2 } },
    '3/4/6': { NY: 4, mix: { A: 3, B: 4, C: 4, D: 2 } },
    '3/3/6': { NY: 3, mix: { A: 3, B: 3, C: 3, D: 1 } },
  };

  // Wohnungstypen: Zahl der Wohnmodule und erlaubte Zusatzmodule
  const TYPEN = {
    A: { name: 'Through', module: 3, zusatz: [1, 1] },  // eine Reihe Ost-West
    B: { name: 'Bent',    module: 4, zusatz: [1, 1] },  // Reihe + 1 Modul seitlich (L oder T)
    C: { name: 'Split',   module: 5, zusatz: [1, 2] },  // Reihe + 2 Module eine Ebene höher oder tiefer
    D: { name: 'Stacked', module: 6, zusatz: [2, 2] },  // zwei Reihen übereinander
  };

  // Laubengänge abwechselnd: Ebene 1, 3, 5 auf der Seite x = 2,
  // Ebene 2, 4, 6 auf der Seite x = 0 (z zählt ab 0).
  function laubengang(z) {
    return z % 2 === 0 ? 2 : 0;
  }

  // ---------------------------------------------------------------
  // 2. Hilfsmittel
  // ---------------------------------------------------------------

  // Zufallszahlen mit Startwert (gleicher Startwert = gleiche Variante)
  function zufall(startwert) {
    let s = startwert >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mischen(liste, rnd) {
    const a = liste.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const NACHBARN_EBENE = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const NACHBARN_RAUM = NACHBARN_EBENE.concat([[0, 0, 1], [0, 0, -1]]);

  function raster(NY) {
    const L = NX * NY;              // Module pro Ebene
    const N = L * NZ;               // Module im Block
    return {
      NY, L, N,
      nr: (x, y, z) => x + NX * (y + NY * z),
      xyz: i => [i % NX, Math.floor(i / NX) % NY, Math.floor(i / L)],
      imBlock: (x, y, z) => x >= 0 && x < NX && y >= 0 && y < NY && z >= 0 && z < NZ,
      fassade: x => x === 0 || x === NX - 1,   // nur Ost und West zählen als Aussenluft
    };
  }

  // ---------------------------------------------------------------
  // 3. Alle möglichen Lagen jeder Wohnung im Block
  // ---------------------------------------------------------------

  function alleLagen(R) {
    const lagen = [];
    const reihe = (y, z) => [[0, y, z], [1, y, z], [2, y, z]];
    for (let z = 0; z < NZ; z++) {
      for (let y = 0; y < R.NY; y++) {
        const r = reihe(y, z);
        // A: eine Reihe
        lagen.push({ typ: 'A', module: r });
        // D: zwei Reihen übereinander
        if (z + 1 < NZ) lagen.push({ typ: 'D', module: r.concat(reihe(y, z + 1)) });
        // C: Reihe + Modul an der Laubengangseite und mittleres Modul,
        //    eine Ebene höher oder tiefer
        for (const z2 of [z - 1, z + 1]) {
          if (z2 < 0 || z2 >= NZ) continue;
          lagen.push({ typ: 'C', module: r.concat([[laubengang(z2), y, z2], [1, y, z2]]) });
        }
        // B: Reihe + ein Modul nördlich oder südlich an einem der drei Reihenmodule
        for (const x of [0, 1, 2]) {
          for (const y2 of [y - 1, y + 1]) {
            if (y2 < 0 || y2 >= R.NY) continue;
            lagen.push({ typ: 'B', module: r.concat([[x, y2, z]]) });
          }
        }
      }
    }
    for (const l of lagen) {
      l.zellen = l.module.map(m => R.nr(...m));
      l.erste = Math.min(...l.zellen);
      l.oben = Math.max(...l.module.map(m => m[2]));
    }
    // Nach erster Zelle sortiert: die Suche füllt den Block Zelle für Zelle
    const abZelle = Array.from({ length: R.N }, () => []);
    for (const l of lagen) abZelle[l.erste].push(l);
    return abZelle;
  }

  // ---------------------------------------------------------------
  // 4. Zufallsgenerator
  //    Füllt den Block Zelle für Zelle (x, dann y, dann z). Jede Zelle
  //    wird entweder leer oder der Anfang einer Wohnung. Nach jeder
  //    fertigen Ebene wird geprüft, ob die Leermodule noch verteilt
  //    werden können. Am Schluss werden die Leermodule als Zusatzmodule
  //    den Wohnungen zugeteilt.
  // ---------------------------------------------------------------

  function erzeuge(groesse, startwert, maxSchritte) {
    const { NY, mix } = GROESSEN[groesse];
    const R = raster(NY);
    const rnd = zufall(startwert);
    const abZelle = alleLagen(R);

    let wohnmodule = 0;
    for (const t in mix) wohnmodule += mix[t] * TYPEN[t].module;
    const leerSoll = R.N - wohnmodule;

    const zelle = new Int16Array(R.N).fill(-1);  // -1 offen, 0 leer, k+1 = Wohnung k
    const rest = Object.assign({}, mix);
    const wohnungen = [];
    let leer = 0, offen = R.N, schritte = 0, ergebnis = null;

    const maxZusatz = k => TYPEN[wohnungen[k].typ].zusatz[1];
    const minZusatz = k => TYPEN[wohnungen[k].typ].zusatz[0];

    // Leermodule bis Zelle "bis" und die Wohnungen, an die sie grenzen
    // (gemeinsame Wand auf derselben Ebene)
    function leereMitNachbarn(bis) {
      const leere = [], nachbarn = [];
      for (let i = 0; i < bis; i++) {
        if (zelle[i] !== 0) continue;
        const [x, y, z] = R.xyz(i);
        const s = new Set();
        for (const [dx, dy] of NACHBARN_EBENE) {
          const X = x + dx, Y = y + dy;
          if (R.imBlock(X, Y, z) && zelle[R.nr(X, Y, z)] > 0) s.add(zelle[R.nr(X, Y, z)] - 1);
        }
        leere.push(i);
        nachbarn.push([...s]);
      }
      return { leere, nachbarn };
    }

    // Prüfung nach Ebene z: Jedes Leermodul braucht eine Wohnung daneben,
    // alle zusammen müssen verteilbar sein (Paarung mit Kapazitäten), und
    // jede abgeschlossene Wohnung hat genug Leermodule daneben.
    function ebeneMoeglich(z) {
      const { leere, nachbarn } = leereMitNachbarn(R.L * (z + 1));
      if (nachbarn.some(n => n.length === 0)) return false;
      const plaetze = [];
      wohnungen.forEach((w, k) => { for (let j = 0; j < maxZusatz(k); j++) plaetze.push(k); });
      const belegt = new Array(plaetze.length).fill(-1);
      function vergib(v, gesehen) {
        for (const k of nachbarn[v]) {
          for (let j = 0; j < plaetze.length; j++) {
            if (plaetze[j] !== k || gesehen.has(j)) continue;
            gesehen.add(j);
            if (belegt[j] < 0 || vergib(belegt[j], gesehen)) { belegt[j] = v; return true; }
          }
        }
        return false;
      }
      for (let v = 0; v < leere.length; v++) if (!vergib(v, new Set())) return false;
      for (let k = 0; k < wohnungen.length; k++) {
        if (wohnungen[k].oben > z) continue;
        if (nachbarn.filter(n => n.includes(k)).length < minZusatz(k)) return false;
      }
      return true;
    }

    // Regel 3: Jedes Zusatzmodul erreicht die Ost- oder Westfassade,
    // direkt oder über Zusatzmodule derselben Wohnung.
    function nichtGefangen(besitzer) {
      const frei = new Array(R.N).fill(false), stapel = [];
      for (let i = 0; i < R.N; i++) {
        if (besitzer[i] >= 0 && R.fassade(R.xyz(i)[0])) { frei[i] = true; stapel.push(i); }
      }
      while (stapel.length) {
        const i = stapel.pop();
        const [x, y, z] = R.xyz(i);
        for (const [dx, dy, dz] of NACHBARN_RAUM) {
          const X = x + dx, Y = y + dy, Z = z + dz;
          if (!R.imBlock(X, Y, Z)) continue;
          const j = R.nr(X, Y, Z);
          if (!frei[j] && besitzer[j] === besitzer[i]) { frei[j] = true; stapel.push(j); }
        }
      }
      for (let i = 0; i < R.N; i++) if (besitzer[i] >= 0 && !frei[i]) return false;
      return true;
    }

    // Leermodule den Wohnungen zuteilen (Rückverfolgung)
    function zuteilen() {
      const { leere, nachbarn } = leereMitNachbarn(R.N);
      const reihenfolge = mischen(leere.map((_, k) => k), rnd)
        .sort((a, b) => nachbarn[a].length - nachbarn[b].length);
      const anzahl = new Array(wohnungen.length).fill(0);
      const besitzer = new Array(R.N).fill(-1);
      let loesung = null;
      (function weiter(n) {
        if (loesung) return;
        if (n === reihenfolge.length) {
          for (let k = 0; k < wohnungen.length; k++) if (anzahl[k] < minZusatz(k)) return;
          if (nichtGefangen(besitzer)) loesung = besitzer.slice();
          return;
        }
        const v = reihenfolge[n];
        for (const k of mischen(nachbarn[v], rnd)) {
          if (anzahl[k] >= maxZusatz(k)) continue;
          anzahl[k]++; besitzer[leere[v]] = k;
          weiter(n + 1);
          besitzer[leere[v]] = -1; anzahl[k]--;
          if (loesung) return;
        }
      })(0);
      return loesung;
    }

    function suche(i) {
      if (ergebnis || ++schritte > maxSchritte) return;
      while (i < R.N && zelle[i] !== -1) i++;
      if (i % R.L === 0 && i > 0 && !ebeneMoeglich(i / R.L - 1)) return;
      if (i === R.N) {
        const besitzer = zuteilen();
        if (besitzer) {
          ergebnis = wohnungen.map((w, k) => ({
            typ: w.typ,
            module: w.module,
            zusatz: besitzer.map((b, c) => b === k ? R.xyz(c) : null).filter(Boolean),
          }));
        }
        return;
      }
      // Restliche Module müssen genau aufgehen
      let bedarf = leerSoll - leer;
      for (const t in rest) bedarf += rest[t] * TYPEN[t].module;
      if (bedarf !== offen) return;

      const optionen = [];
      if (leer < leerSoll) optionen.push(null);   // null = Zelle bleibt leer
      for (const l of abZelle[i]) {
        if (rest[l.typ] > 0 && l.zellen.every(c => zelle[c] === -1)) optionen.push(l);
      }
      for (const l of mischen(optionen, rnd)) {
        if (l === null) {
          zelle[i] = 0; leer++; offen--;
          suche(i + 1);
          offen++; leer--; zelle[i] = -1;
        } else {
          const k = wohnungen.length + 1;
          l.zellen.forEach(c => { zelle[c] = k; });
          rest[l.typ]--; offen -= l.zellen.length; wohnungen.push(l);
          suche(i + 1);
          wohnungen.pop(); offen += l.zellen.length; rest[l.typ]++;
          l.zellen.forEach(c => { zelle[c] = -1; });
        }
        if (ergebnis || schritte > maxSchritte) return;
      }
    }

    suche(0);
    return ergebnis;   // null, wenn in maxSchritte nichts gefunden
  }

  // ---------------------------------------------------------------
  // 5. Unabhängige Prüfung einer Variante gegen alle Regeln
  //    Gibt eine Liste von Fehlern zurück, leer = gültig.
  // ---------------------------------------------------------------

  function pruefe(variante, groesse) {
    const { NY, mix } = GROESSEN[groesse];
    const R = raster(NY);
    const fehler = [];
    const block = new Array(R.N).fill(null);

    variante.forEach((w, k) => {
      for (const m of w.module.concat(w.zusatz)) {
        if (!R.imBlock(...m)) { fehler.push('ausserhalb des Blocks'); continue; }
        const i = R.nr(...m);
        if (block[i]) fehler.push('Modul doppelt belegt');
        block[i] = { k, wohnen: w.module.includes(m) };
      }
    });
    if (block.some(b => !b)) fehler.push('nicht alle Module belegt');

    const zahl = { A: 0, B: 0, C: 0, D: 0 };
    variante.forEach(w => { zahl[w.typ]++; });
    for (const t in mix) if (zahl[t] !== mix[t]) fehler.push('Wohnungsmix stimmt nicht');

    for (const w of variante) {
      const m = w.module, z = new Set(m.map(q => q[2]));
      if (!m.some(q => q[0] === 0) || !m.some(q => q[0] === NX - 1)) fehler.push(w.typ + ': reicht nicht von Ost bis West');
      const [lo, hi] = TYPEN[w.typ].zusatz;
      if (w.zusatz.length < lo || w.zusatz.length > hi) fehler.push(w.typ + ': falsche Zahl Zusatzmodule');
      for (const v of w.zusatz) {
        const daneben = m.some(q => q[2] === v[2] && Math.abs(q[0] - v[0]) + Math.abs(q[1] - v[1]) === 1);
        if (!daneben) fehler.push(w.typ + ': Zusatzmodul nicht neben der eigenen Wohnung');
      }
      if (w.typ === 'A' && (m.length !== 3 || z.size !== 1)) fehler.push('A: Form');
      if (w.typ === 'B' && (m.length !== 4 || z.size !== 1 || Math.abs(m[3][1] - m[0][1]) !== 1)) fehler.push('B: Form');
      if (w.typ === 'C') {
        const halb = m.slice(3);
        if (m.length !== 5 || z.size !== 2 || !halb.every(q => q[0] === 1 || q[0] === laubengang(q[2]))) fehler.push('C: Form');
      }
      if (w.typ === 'D' && (m.length !== 6 || z.size !== 2)) fehler.push('D: Form');
    }

    // Kein gefangenes Leermodul
    const frei = new Array(R.N).fill(false), stapel = [];
    for (let i = 0; i < R.N; i++) {
      if (block[i] && !block[i].wohnen && R.fassade(R.xyz(i)[0])) { frei[i] = true; stapel.push(i); }
    }
    while (stapel.length) {
      const i = stapel.pop(), [x, y, z] = R.xyz(i);
      for (const [dx, dy, dz] of NACHBARN_RAUM) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (!R.imBlock(X, Y, Z)) continue;
        const j = R.nr(X, Y, Z);
        if (!frei[j] && block[j] && !block[j].wohnen && block[j].k === block[i].k) { frei[j] = true; stapel.push(j); }
      }
    }
    for (let i = 0; i < R.N; i++) if (block[i] && !block[i].wohnen && !frei[i]) fehler.push('gefangenes Leermodul');

    return fehler;
  }

  // ---------------------------------------------------------------
  // 6. Suche mit mehreren Startwerten, bis eine Variante gefunden ist
  // ---------------------------------------------------------------

  const SCHRITTE = { '3/5/6': 1000000, '3/4/6': 3000000, '3/3/6': 300000 };

  function findeVariante(groesse, startwert, versuche, meldung) {
    for (let n = 0; n < versuche; n++) {
      if (meldung) meldung(n + 1);
      const v = erzeuge(groesse, startwert + n, SCHRITTE[groesse]);
      if (v && pruefe(v, groesse).length === 0) return { variante: v, startwert: startwert + n };
    }
    return null;
  }

  const TypeZero = { NX, NZ, GROESSEN, TYPEN, laubengang, erzeuge, pruefe, findeVariante };

  // Als Web Worker: rechnet im Hintergrund, die Seite bleibt bedienbar
  if (typeof WorkerGlobalScope !== 'undefined' && global instanceof WorkerGlobalScope) {
    global.onmessage = e => {
      const { groesse, startwert } = e.data;
      const r = findeVariante(groesse, startwert, 200, n => global.postMessage({ versuch: n }));
      global.postMessage({ fertig: true, ergebnis: r });
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = TypeZero;
  else global.TypeZero = TypeZero;

})(typeof self !== 'undefined' ? self : globalThis);
