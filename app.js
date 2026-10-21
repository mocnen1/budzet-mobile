/*
 * Budżet – mini aplikacja na telefon.
 * Zapisuje wydatki/przychody/transfery na bieżąco, a potem przesyła je do aplikacji
 * na Windows kodami QR. Wszystkie dane zostają WYŁĄCZNIE na tym telefonie
 * (IndexedDB przeglądarki) – strona nie wysyła niczego do internetu.
 */
'use strict';

const WERSJA = '1.0.0';
const PREFIKS = 'BT1';
const LIMIT_HISTORII = 50;          // ile PRZENIESIONYCH pozycji trzymać w historii
const FORMAT_POZYCJI = 'budzet-tel';
const FORMAT_KONFIGURACJI = 'budzet-cfg';

// Ile znaków danych w jednym kodzie. Mniej = kod mniej gęsty = kamera laptopa czyta go dużo pewniej.
const ROZMIARY_QR = { maly: 140, sredni: 220, duzy: 350 };
const TEMPA_QR = { wolno: 2000, normalnie: 1300, szybko: 800 };
const TYPY_KONT = { gotowka: 'Gotówka', karta: 'Karta', konto_bankowe: 'Konto bankowe', oszczednosci: 'Oszczędności' };

// ============================================================================
// Pomocnicze: DOM
// ============================================================================

/** Tworzy element: h('div', {class:'x', onclick: fn}, 'tekst', innyElement). Tekst jest zawsze
 *  wstawiany jako tekst (nigdy jako HTML) – brak ryzyka wstrzyknięcia kodu przez opis transakcji. */
function h(tag, attrs, ...dzieci) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const d of dzieci.flat()) {
    if (d === null || d === undefined || d === false) continue;
    el.append(d instanceof Node ? d : document.createTextNode(String(d)));
  }
  return el;
}
const $ = (s) => document.querySelector(s);

function toast(tekst, ms = 2200) {
  const t = $('#toast');
  t.textContent = tekst;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ============================================================================
// Pomocnicze: formatowanie
// ============================================================================

function fmtKwota(grosze) {
  const zl = Math.abs(grosze) / 100;
  const [c, u] = zl.toFixed(2).split('.');
  return c.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + u + ' zł';
}

/** "12,5" / "12.50" / "1 234,5" -> grosze (int). Zwraca NaN gdy niepoprawne. */
function parsujKwote(s) {
  if (typeof s !== 'string') return NaN;
  const czyste = s.replace(/[\s zł]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(czyste)) return NaN;
  return Math.round(parseFloat(czyste) * 100);
}

function groszeNaTekst(g) {
  return (g / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');
}

function dzis() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DNI = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const MIES = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia',
  'września', 'października', 'listopada', 'grudnia'];
function fmtDzien(iso) {
  const [r, m, d] = iso.split('-').map(Number);
  const dt = new Date(r, m - 1, d);
  const pref = iso === dzis() ? 'Dziś, ' : '';
  const t = `${DNI[dt.getDay()]}, ${d} ${MIES[m - 1]}${r !== new Date().getFullYear() ? ' ' + r : ''}`;
  return pref ? pref + t : t.charAt(0).toUpperCase() + t.slice(1);
}

function noweId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('').slice(0, 12);
}

// ============================================================================
// Baza w telefonie (IndexedDB)
// ============================================================================

const DB = {
  db: null,
  otworz() {
    return new Promise((ok, blad) => {
      const req = indexedDB.open('budzet-mobile', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('pozycje', { keyPath: 'u' });
        db.createObjectStore('zdjecia', { keyPath: 'u' });
        db.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => { DB.db = req.result; ok(); };
      req.onerror = () => blad(req.error);
    });
  },
  _tx(store, tryb, fn) {
    return new Promise((ok, blad) => {
      const tx = DB.db.transaction(store, tryb);
      const s = tx.objectStore(store);
      const wynik = fn(s);
      tx.oncomplete = () => ok(wynik && 'result' in wynik ? wynik.result : undefined);
      tx.onerror = () => blad(tx.error);
      tx.onabort = () => blad(tx.error);
    });
  },
  wszystkie: (store) => DB._tx(store, 'readonly', (s) => s.getAll()),
  pobierz: (store, klucz) => DB._tx(store, 'readonly', (s) => s.get(klucz)),
  zapisz: (store, wartosc) => DB._tx(store, 'readwrite', (s) => { s.put(wartosc); }),
  usun: (store, klucz) => DB._tx(store, 'readwrite', (s) => { s.delete(klucz); }),
  wyczysc: (store) => DB._tx(store, 'readwrite', (s) => { s.clear(); }),
};

async function kvGet(k, dom) {
  const r = await DB.pobierz('kv', k);
  return r === undefined ? dom : r.v;
}
const kvSet = (k, v) => DB.zapisz('kv', { k, v });

// ============================================================================
// Stan aplikacji
// ============================================================================

const S = {
  pozycje: [],
  cfg: null,            // {ts, k:[[id,parent,nazwa,'w'|'p']], a:[[id,nazwa,typ]]}
  kat: new Map(),       // id -> {id, parent, nazwa, typ, sciezka}
  konta: new Map(),     // id -> {id, nazwa, typ}
  urzadzenie: { nazwa: '', id: '' },
  ustaw: { rozmiar: 'sredni', tempo: 'normalnie' },
  ostatnie: { konto: {}, typ: 'w' },
  widok: 'dodaj',
  filtrHistorii: 'wszystkie',
  wyslijWszystko: false,
};

function statusPozycji(p) {
  if (p.x) return 'usunieta';
  if (!p.s) return 'nowa';
  if (p.r > p.s) return 'zmieniona';
  return 'wyslana';
}
const ETYKIETY_STATUSU = {
  nowa: 'do wysłania', zmieniona: 'zmieniona – do wysłania',
  usunieta: 'do usunięcia na PC', wyslana: '✓ przeniesiona',
};
const oczekujace = () => S.pozycje.filter((p) => statusPozycji(p) !== 'wyslana');

function ustawKonfiguracje(cfg) {
  S.cfg = cfg;
  S.kat = new Map();
  S.konta = new Map();
  if (!cfg) return;
  for (const [id, parent, nazwa, typ] of cfg.k) S.kat.set(id, { id, parent, nazwa, typ });
  for (const k of S.kat.values()) {
    const czesci = [];
    let x = k, straz = 0;
    while (x && straz++ < 20) { czesci.unshift(x.nazwa); x = S.kat.get(x.parent); }
    k.sciezka = czesci.join(' › ');
  }
  for (const [id, nazwa, typ] of cfg.a) S.konta.set(id, { id, nazwa, typ });
}

function kategorieTypu(t) {
  return [...S.kat.values()].filter((k) => k.typ === t)
    .sort((a, b) => a.sciezka.localeCompare(b.sciezka, 'pl'));
}

const nazwaKonta = (id) => (S.konta.get(id) || {}).nazwa || `(konto #${id})`;
const nazwaKategorii = (id) => (id == null ? 'Bez kategorii' : (S.kat.get(id) || {}).sciezka || `(kategoria #${id})`);
const krotkaKategoria = (id) => (id == null ? 'Bez kategorii' : (S.kat.get(id) || {}).nazwa || `(kategoria #${id})`);

async function zapiszPozycje(p) {
  await DB.zapisz('pozycje', p);
  const i = S.pozycje.findIndex((x) => x.u === p.u);
  if (i >= 0) S.pozycje[i] = p; else S.pozycje.push(p);
}

async function usunPozycjeCalkiem(u) {
  await DB.usun('pozycje', u);
  await DB.usun('zdjecia', u);
  S.pozycje = S.pozycje.filter((p) => p.u !== u);
}

/** Trzyma w historii max LIMIT_HISTORII przeniesionych pozycji (oczekujące nigdy nie są usuwane). */
async function przytnijHistorie() {
  const wyslane = S.pozycje.filter((p) => statusPozycji(p) === 'wyslana')
    .sort((a, b) => (b.d + b.cr).localeCompare(a.d + a.cr));
  for (const p of wyslane.slice(LIMIT_HISTORII)) await usunPozycjeCalkiem(p.u);
}

// ============================================================================
// Kompresja + kodowanie (zgodne z db/telefon.py po stronie PC)
// ============================================================================

function b64url(bajty) {
  let s = '';
  for (let i = 0; i < bajty.length; i += 0x8000) s += String.fromCharCode.apply(null, bajty.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function z64url(t) {
  t = t.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const s = atob(t);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
async function przepusc(bajty, strumien) {
  const odp = new Response(new Blob([bajty]).stream().pipeThrough(strumien));
  return new Uint8Array(await odp.arrayBuffer());
}
async function zakoduj(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  return b64url(await przepusc(json, new CompressionStream('deflate-raw')));
}
async function zdekoduj(tekst) {
  const bajty = await przepusc(z64url(tekst), new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(bajty));
}

function podzielNaCzesci(tekst, rozmiar) {
  const a = new Uint8Array(2);
  crypto.getRandomValues(a);
  const sesja = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  const fr = [];
  for (let i = 0; i < tekst.length; i += rozmiar) fr.push(tekst.slice(i, i + rozmiar));
  if (!fr.length) fr.push('');
  return fr.map((f, i) => `${PREFIKS}:${sesja}:${i + 1}:${fr.length}:${f}`);
}

class Zbieracz {
  constructor() { this.reset(); }
  reset() { this.sesja = null; this.liczba = 0; this.czesci = new Map(); }
  dodaj(t) {
    if (!t || !t.startsWith(PREFIKS + ':')) return false;
    const el = t.split(':');
    if (el.length < 5) return false;
    const [, sesja, nrS, liczbaS] = el;
    const dane = el.slice(4).join(':');
    const nr = parseInt(nrS, 10), liczba = parseInt(liczbaS, 10);
    if (!(nr >= 1 && nr <= liczba && liczba <= 500)) return false;
    if (sesja !== this.sesja) { this.sesja = sesja; this.liczba = liczba; this.czesci = new Map(); }
    if (this.czesci.has(nr)) return false;
    this.czesci.set(nr, dane);
    return true;
  }
  get kompletne() { return this.liczba > 0 && this.czesci.size === this.liczba; }
  tekst() { let s = ''; for (let i = 1; i <= this.liczba; i++) s += this.czesci.get(i); return s; }
}

function paczkaDoWyslania(pozycje) {
  return {
    f: FORMAT_POZYCJI, v: 1,
    dev: S.urzadzenie.nazwa || 'Telefon', did: S.urzadzenie.id,
    ts: new Date().toISOString().slice(0, 16),
    i: pozycje.map((p) => {
      const o = { u: p.u, r: p.r, t: p.t, d: p.d, k: p.k, a: p.a };
      if (p.t !== 't' && p.c != null) o.c = p.c;
      if (p.t === 't') o.b = p.b;
      if (p.o) o.o = p.o;
      if (p.n) o.n = p.n;
      if (p.x) o.x = 1;
      if (p.f) o.f = 1;
      return o;
    }),
  };
}

// ============================================================================
// Kod QR na canvasie
// ============================================================================

function rysujQR(canvas, tekst) {
  const qr = qrcode(0, 'M');
  qr.addData(tekst, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const margines = 4;
  const skala = Math.max(4, Math.floor(1000 / (n + 2 * margines)));
  const bok = (n + 2 * margines) * skala;
  canvas.width = bok; canvas.height = bok;
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, bok, bok);
  c.fillStyle = '#000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (qr.isDark(y, x)) c.fillRect((x + margines) * skala, (y + margines) * skala, skala, skala);
  }
}

// ============================================================================
// Nawigacja
// ============================================================================

const TYTULY = { dodaj: 'Dodaj', historia: 'Historia', wyslij: 'Wyślij do PC', ustawienia: 'Ustawienia' };

function przejdz(widok) {
  S.widok = widok;
  document.querySelectorAll('nav.dol button').forEach((b) => b.classList.toggle('aktywny', b.dataset.widok === widok));
  $('#tytul').textContent = TYTULY[widok];
  if (S.banerInstalacji) $('#baner-instalacji').hidden = !['dodaj', 'ustawienia'].includes(widok);
  const m = $('#widok');
  m.replaceChildren();
  ({ dodaj: widokDodaj, historia: widokHistoria, wyslij: widokWyslij, ustawienia: widokUstawienia })[widok](m);
  odswiezLiczniki();
  window.scrollTo(0, 0);
}

function odswiezLiczniki() {
  const n = oczekujace().length;
  const b = $('#badge-wyslij');
  b.hidden = n === 0;
  b.textContent = n;
  const p = $('#licznik-oczekujace');
  p.hidden = n === 0;
  p.textContent = `Do wysłania: ${n}`;
}

/** Pełnoekranowa warstwa nad aplikacją. Warstwy mogą się nakładać (np. zdjęcie nad edycją). */
function otworzNakladke(tytul, zawartosc, { przyZamknieciu, jasna } = {}) {
  let zamknieta = false;
  const n = h('div', { class: `nakladka ${jasna ? 'ciemna' : ''}`, role: 'dialog' });
  const zamknij = () => {
    if (zamknieta) return;
    zamknieta = true;
    n.remove();
    if (!document.querySelector('.nakladka')) document.body.style.overflow = '';
    if (przyZamknieciu) przyZamknieciu();
  };
  n.append(
    h('div', { class: 'naglowek-nakladki' }, h('h2', {}, tytul), h('button', { class: 'x', onclick: zamknij, 'aria-label': 'Zamknij' }, '✕')),
    zawartosc,
  );
  n.style.zIndex = String(50 + document.querySelectorAll('.nakladka').length);
  document.body.append(n);
  document.body.style.overflow = 'hidden';
  return zamknij;
}

// ============================================================================
// Formularz pozycji (dodawanie i edycja)
// ============================================================================

async function przygotujZdjecie(plik) {
  const url = URL.createObjectURL(plik);
  try {
    const img = await new Promise((ok, blad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => blad(new Error('Nie udało się wczytać zdjęcia'));
      i.src = url;
    });
    const MAX = 1600;
    const sk = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * sk);
    c.height = Math.round(img.naturalHeight * sk);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pokazZdjecie(blob, { onUsun } = {}) {
  const url = URL.createObjectURL(blob);
  const zawartosc = h('div', {},
    h('img', { class: 'zdjecie-pelne', src: url, alt: 'Zdjęcie paragonu' }),
    h('p', { class: 'male' }, 'Zdjęcie jest tylko na tym telefonie. Aby dodać je do budżetu na PC, '
      + 'zapisz je (przytrzymaj zdjęcie albo użyj przycisku poniżej) i dołącz ręcznie w aplikacji na Windows.'),
    navigator.canShare && navigator.canShare({ files: [new File([blob], 'paragon.jpg', { type: 'image/jpeg' })] })
      ? h('button', {
        class: 'btn obrys maly', onclick: () => navigator.share({ files: [new File([blob], 'paragon.jpg', { type: 'image/jpeg' })] }).catch(() => {}),
      }, '📤 Udostępnij / zapisz zdjęcie')
      : h('a', { class: 'btn obrys maly', href: url, download: 'paragon.jpg' }, '⬇️ Pobierz zdjęcie'),
    onUsun ? h('button', { class: 'btn czerwony maly', onclick: () => { zamknij(); onUsun(); } }, '🗑️ Usuń zdjęcie') : null,
  );
  const zamknij = otworzNakladke('Zdjęcie', zawartosc, { przyZamknieciu: () => URL.revokeObjectURL(url) });
}

/**
 * Buduje formularz. `poz` = null dla nowej pozycji.
 * opcje: { naZapis(p), naUsun(p), naPrzywroc(p) }
 */
async function formularz(poz, opcje) {
  const nowa = !poz;
  const f = {
    t: poz ? poz.t : S.ostatnie.typ,
    kwota: poz ? groszeNaTekst(poz.k) : '',
    d: poz ? poz.d : dzis(),
    c: poz ? poz.c : null,
    a: poz ? poz.a : null,
    b: poz ? poz.b : null,
    o: poz ? poz.o || '' : '',
    n: poz ? poz.n || '' : '',
    zdjecie: null,            // Blob
    zdjecieZmienione: false,
  };
  if (poz && poz.f) {
    const z = await DB.pobierz('zdjecia', poz.u);
    if (z) f.zdjecie = z.blob;
  }
  const usunieta = poz && poz.x;

  const kontener = h('div', {});
  const rysuj = () => {
    kontener.replaceChildren();
    if (usunieta) {
      kontener.append(h('div', { class: 'info blad' },
        'Ta pozycja jest oznaczona do usunięcia. Przy najbliższym wysyłaniu zostanie usunięta z budżetu na PC.'));
    }
    const klasa = { w: 'wyd', p: 'prz', t: 'tra' }[f.t];

    // Typ
    const seg = h('div', { class: 'segment' },
      ...[['w', 'wyd', 'Wydatek'], ['p', 'prz', 'Przychód'], ['t', 'tra', 'Transfer']].map(([t, k, et]) =>
        h('button', {
          type: 'button', class: `${k} ${f.t === t ? 'aktywny' : ''}`, disabled: usunieta,
          onclick: () => {
            if (f.t === t) return;
            zbierz(); f.t = t;
            if (t === 't') f.c = null;
            else if (f.c != null && (S.kat.get(f.c) || {}).typ !== t) f.c = null;
            if (nowa) f.a = S.ostatnie.konto[t] ?? f.a;
            rysuj();
          },
        }, et)));
    kontener.append(seg);

    // Kwota
    const kwotaInput = h('input', {
      id: 'f-kwota', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', value: f.kwota, disabled: usunieta,
      enterkeyhint: 'done',
    });
    kontener.append(h('div', { class: `kwota-wrap ${klasa}` }, kwotaInput, h('span', { class: 'waluta' }, 'zł')));

    // Kategoria
    if (f.t !== 't') {
      const lista = kategorieTypu(f.t);
      // Ostatnio używane kategorie tego typu - szybki wybór
      const ostatnie = [];
      for (const p of [...S.pozycje].sort((a, b) => b.cr.localeCompare(a.cr))) {
        if (p.t === f.t && p.c != null && S.kat.has(p.c) && !ostatnie.includes(p.c)) ostatnie.push(p.c);
        if (ostatnie.length >= 6) break;
      }
      const sel = h('select', { id: 'f-kat', disabled: usunieta },
        h('option', { value: '' }, '— bez kategorii —'),
        // Kategoria usunięta na PC po pobraniu konfiguracji - nie gubimy jej po cichu
        f.c != null && !lista.some((k) => k.id === f.c)
          ? h('option', { value: f.c, selected: true }, `(kategoria #${f.c} – nieaktualna)`) : null,
        ...lista.map((k) => h('option', { value: k.id, selected: f.c === k.id }, k.sciezka)));
      kontener.append(h('div', { class: 'pole' }, h('label', { for: 'f-kat' }, 'Kategoria'), sel));
      if (ostatnie.length && !usunieta) {
        kontener.append(h('div', { class: 'chipy' }, ...ostatnie.map((id) => h('button', {
          type: 'button', class: `chip ${f.c === id ? 'aktywny' : ''}`,
          onclick: () => { zbierz(); f.c = f.c === id ? null : id; rysuj(); },
        }, krotkaKategoria(id)))));
      }
    }

    // Konta
    const konta = [...S.konta.values()];
    if (f.a == null || !S.konta.has(f.a)) f.a = S.ostatnie.konto[f.t] ?? (konta[0] || {}).id ?? null;
    const opcjeKont = (wybrane) => konta.map((k) => {
    const typ = TYPY_KONT[k.typ] || k.typ;
    return h('option', { value: k.id, selected: wybrane === k.id }, k.nazwa === typ ? k.nazwa : `${k.nazwa} (${typ})`);
  });
    if (f.t === 't') {
      if (f.b == null || f.b === f.a) f.b = (konta.find((k) => k.id !== f.a) || {}).id ?? null;
      kontener.append(h('div', { class: 'dwa' },
        h('div', { class: 'pole' }, h('label', { for: 'f-konto' }, 'Z konta'),
          h('select', { id: 'f-konto', disabled: usunieta }, ...opcjeKont(f.a))),
        h('div', { class: 'pole' }, h('label', { for: 'f-konto2' }, 'Na konto'),
          h('select', { id: 'f-konto2', disabled: usunieta }, ...opcjeKont(f.b)))));
    } else {
      kontener.append(h('div', { class: 'pole' },
        h('label', { for: 'f-konto' }, f.t === 'w' ? 'Zapłacono z' : 'Wpłynęło na'),
        h('select', { id: 'f-konto', disabled: usunieta }, ...opcjeKont(f.a))));
    }

    // Data + opis
    kontener.append(
      h('div', { class: 'pole' }, h('label', { for: 'f-data' }, 'Data'),
        h('input', { id: 'f-data', type: 'date', value: f.d, max: '2099-12-31', disabled: usunieta })),
      h('div', { class: 'pole' }, h('label', { for: 'f-opis' }, 'Opis'),
        h('input', {
          id: 'f-opis', value: f.o, maxlength: 120, autocomplete: 'off', disabled: usunieta,
          placeholder: f.t === 'w' ? 'np. Biedronka, obiad, paliwo' : f.t === 'p' ? 'np. wypłata' : 'np. zasilenie karty',
        })),
      h('div', { class: 'pole' }, h('label', { for: 'f-notatka' }, 'Notatka (opcjonalnie)'),
        h('textarea', { id: 'f-notatka', maxlength: 500, disabled: usunieta }, f.n)),
    );

    // Zdjęcie (tylko wydatki/przychody)
    if (f.t !== 't' && !usunieta) {
      const plik = h('input', { type: 'file', accept: 'image/*', hidden: true });
      plik.addEventListener('change', async () => {
        if (!plik.files || !plik.files[0]) return;
        try {
          zbierz();
          f.zdjecie = await przygotujZdjecie(plik.files[0]);
          f.zdjecieZmienione = true;
          rysuj();
        } catch (e) { toast(e.message); }
      });
      if (f.zdjecie) {
        const url = URL.createObjectURL(f.zdjecie);
        kontener.append(h('div', { class: 'zdjecie-podglad' },
          h('img', {
            src: url, alt: 'Paragon',
            onclick: () => pokazZdjecie(f.zdjecie, { onUsun: () => { f.zdjecie = null; f.zdjecieZmienione = true; rysuj(); } }),
          }),
          h('div', {}, h('div', {}, '📷 Zdjęcie paragonu'), h('div', { class: 'male' }, 'Dotknij, aby powiększyć. Zostaje tylko na telefonie.')),
        ));
      } else {
        kontener.append(plik, h('button', { type: 'button', class: 'btn szary maly', onclick: () => plik.click() }, '📷 Dodaj zdjęcie paragonu'));
      }
    }

    // Przyciski
    if (usunieta) {
      kontener.append(h('button', { class: 'btn zielony', onclick: () => opcje.naPrzywroc(poz) }, '↩️ Przywróć pozycję'));
    } else {
      kontener.append(h('button', { class: `btn ${f.t === 'w' ? 'czerwony' : f.t === 'p' ? 'zielony' : ''}`, onclick: zapisz },
        nowa ? (f.t === 'w' ? 'Zapisz wydatek' : f.t === 'p' ? 'Zapisz przychód' : 'Zapisz transfer') : 'Zapisz zmiany'));
      if (!nowa) kontener.append(h('button', { class: 'btn szary', onclick: () => opcje.naUsun(poz) }, '🗑️ Usuń'));
    }
  };

  const zbierz = () => {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
    if (document.getElementById('f-kwota')) f.kwota = v('f-kwota');
    if (document.getElementById('f-data')) f.d = v('f-data');
    if (document.getElementById('f-kat')) f.c = v('f-kat') ? Number(v('f-kat')) : null;
    if (document.getElementById('f-konto')) f.a = Number(v('f-konto'));
    if (document.getElementById('f-konto2')) f.b = Number(v('f-konto2'));
    if (document.getElementById('f-opis')) f.o = v('f-opis').trim();
    if (document.getElementById('f-notatka')) f.n = v('f-notatka').trim();
  };

  const zapisz = async () => {
    zbierz();
    const k = parsujKwote(f.kwota);
    if (!(k > 0)) { toast('Wpisz poprawną kwotę, np. 12,50'); document.getElementById('f-kwota').focus(); return; }
    if (!f.a) { toast('Wybierz konto'); return; }
    if (f.t === 't' && f.a === f.b) { toast('Konta „z” i „na” muszą być różne'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.d)) { toast('Wybierz datę'); return; }
    const teraz = new Date().toISOString();
    const p = poz ? { ...poz } : { u: noweId(), r: 0, s: 0, q: 0, cr: teraz };
    Object.assign(p, {
      r: p.r + 1, t: f.t, d: f.d, k, a: f.a,
      c: f.t === 't' ? null : f.c, b: f.t === 't' ? f.b : null,
      o: f.o, n: f.n, f: f.t !== 't' && f.zdjecie ? 1 : 0, up: teraz,
    });
    if (f.zdjecieZmienione || (f.t === 't' && poz && poz.f)) {
      if (f.zdjecie && f.t !== 't') await DB.zapisz('zdjecia', { u: p.u, blob: f.zdjecie });
      else await DB.usun('zdjecia', p.u);
    }
    await zapiszPozycje(p);
    S.ostatnie.typ = f.t;
    S.ostatnie.konto[f.t] = f.a;
    await kvSet('ostatnie', S.ostatnie);
    opcje.naZapis(p);
  };

  rysuj();
  return kontener;
}

// ============================================================================
// Widok: Dodaj
// ============================================================================

async function widokDodaj(m) {
  if (!S.cfg) {
    m.append(h('div', { class: 'karta' },
      h('h2', {}, 'Witaj! 👋'),
      h('p', { class: 'opis' }, 'Najpierw pobierz kategorie i konta z aplikacji na komputerze – telefon '
        + 'zapisuje wydatki z dokładnie tymi samymi kategoriami i kontami.'),
      h('ol', { class: 'opis' },
        h('li', {}, 'Na komputerze: zakładka 📱 Telefon → „Wyślij kategorie i konta na telefon”.'),
        h('li', {}, 'Tutaj: Ustawienia → „Pobierz kategorie i konta z PC” i skieruj aparat na ekran.')),
      h('button', { class: 'btn', onclick: () => przejdz('ustawienia') }, 'Przejdź do ustawień')));
    return;
  }
  const karta = h('div', { class: 'karta' });
  m.append(karta);
  const zbuduj = async () => {
    karta.replaceChildren(await formularz(null, {
      naZapis: async (p) => {
        toast(`Zapisano ✓  ${fmtKwota(p.k)}`);
        odswiezLiczniki();
        await zbuduj();
        window.scrollTo(0, 0);
      },
    }));
  };
  await zbuduj();
}

// ============================================================================
// Widok: Historia
// ============================================================================

function wierszPozycji(p, onclick) {
  const st = statusPozycji(p);
  const kl = { w: 'wyd', p: 'prz', t: 'tra' }[p.t];
  const ik = { w: '🛒', p: '💰', t: '🔄' }[p.t];
  const tytul = p.t === 't' ? (p.o || 'Transfer') : (p.o || krotkaKategoria(p.c));
  const pod = p.t === 't'
    ? `${nazwaKonta(p.a)} → ${nazwaKonta(p.b)}`
    : `${p.o ? krotkaKategoria(p.c) + ' • ' : ''}${nazwaKonta(p.a)}`;
  return h('button', { class: `wiersz ${p.x ? 'usunieta' : ''}`, onclick },
    h('div', { class: `ik ${kl}` }, ik),
    h('div', { class: 'srodek' },
      h('div', { class: 'tytul' }, tytul, p.f ? ' 📷' : ''),
      h('div', { class: 'pod' }, pod)),
    h('div', { class: 'prawo' },
      h('div', { class: `kw ${kl}` }, (p.t === 'w' ? '−' : p.t === 'p' ? '+' : '') + fmtKwota(p.k)),
      h('span', { class: `status ${st}` }, ETYKIETY_STATUSU[st])));
}

async function otworzEdycje(p) {
  let zamknij;
  const form = await formularz(p, {
    naZapis: () => { zamknij(); toast('Zapisano zmiany ✓'); },
    naUsun: async (poz) => {
      const st = statusPozycji(poz);
      if (st === 'nowa' && !poz.q) {
        if (!confirm('Usunąć tę pozycję? Nie była jeszcze wysyłana do PC.')) return;
        await usunPozycjeCalkiem(poz.u);
        toast('Usunięto');
      } else {
        if (!confirm('Ta pozycja mogła już trafić do PC. Oznaczyć ją do usunięcia? '
          + 'Przy następnym wysyłaniu PC zaproponuje usunięcie jej z budżetu.')) return;
        await zapiszPozycje({ ...poz, x: 1, r: poz.r + 1, up: new Date().toISOString() });
        toast('Oznaczono do usunięcia');
      }
      zamknij();
    },
    naPrzywroc: async (poz) => {
      await zapiszPozycje({ ...poz, x: 0, r: poz.r + 1, up: new Date().toISOString() });
      toast('Przywrócono');
      zamknij();
    },
  });
  zamknij = otworzNakladke(p.x ? 'Usunięta pozycja' : 'Edytuj', h('div', { class: 'karta' }, form),
    { przyZamknieciu: () => przejdz(S.widok) });
}

function widokHistoria(m) {
  const filtry = [['wszystkie', 'Wszystkie'], ['oczekujace', 'Do wysłania'], ['wyslane', 'Przeniesione']];
  m.append(h('div', { class: 'filtr' }, ...filtry.map(([k, et]) => h('button', {
    class: `chip ${S.filtrHistorii === k ? 'aktywny' : ''}`,
    onclick: () => { S.filtrHistorii = k; przejdz('historia'); },
  }, et))));

  let lista = [...S.pozycje];
  if (S.filtrHistorii === 'oczekujace') lista = lista.filter((p) => statusPozycji(p) !== 'wyslana');
  if (S.filtrHistorii === 'wyslane') lista = lista.filter((p) => statusPozycji(p) === 'wyslana');
  lista.sort((a, b) => (b.d + b.cr).localeCompare(a.d + a.cr));

  if (!lista.length) {
    m.append(h('div', { class: 'pusto' }, S.pozycje.length ? 'Brak pozycji w tym filtrze.' : 'Jeszcze nic nie zapisano.'));
    return;
  }
  let dzien = null, grupa = null;
  for (const p of lista) {
    if (p.d !== dzien) {
      dzien = p.d;
      const suma = lista.filter((x) => x.d === dzien && x.t === 'w' && !x.x).reduce((s, x) => s + x.k, 0);
      m.append(h('div', { class: 'dzien' }, fmtDzien(dzien), suma ? `  •  wydano ${fmtKwota(suma)}` : ''));
      grupa = h('div', { class: 'lista' });
      m.append(grupa);
    }
    grupa.append(wierszPozycji(p, () => otworzEdycje(p)));
  }
  m.append(h('p', { class: 'male' },
    `Historia trzyma wszystkie pozycje do wysłania i ${LIMIT_HISTORII} ostatnich przeniesionych.`));
}

// ============================================================================
// Widok: Wyślij
// ============================================================================

function widokWyslij(m) {
  const ocz = oczekujace();
  const ile = (s) => ocz.filter((p) => statusPozycji(p) === s).length;
  const doWyslania = S.wyslijWszystko ? S.pozycje : ocz;

  m.append(h('div', { class: 'karta' },
    h('h2', {}, 'Do przesłania na komputer'),
    h('div', { class: 'liczby' },
      h('div', {}, h('b', {}, ile('nowa')), h('span', {}, 'nowe')),
      h('div', {}, h('b', {}, ile('zmieniona')), h('span', {}, 'zmienione')),
      h('div', {}, h('b', {}, ile('usunieta')), h('span', {}, 'do usunięcia'))),
    h('label', { class: 'przelacznik' },
      h('input', {
        type: 'checkbox', checked: S.wyslijWszystko,
        onchange: (e) => { S.wyslijWszystko = e.target.checked; przejdz('wyslij'); },
      }),
      h('span', {}, `Wyślij ponownie całą historię (${S.pozycje.length}) – na wypadek, gdyby coś nie dotarło. PC pominie duplikaty.`)),
    h('button', { class: 'btn zielony', disabled: !doWyslania.length, onclick: () => pokazKodyWysylki(doWyslania) },
      doWyslania.length ? `📤 Pokaż kody QR (${doWyslania.length} poz.)` : 'Nie ma nic do wysłania')));

  m.append(h('div', { class: 'karta' },
    h('h2', {}, 'Jak przesłać?'),
    h('ol', { class: 'opis' },
      h('li', {}, 'Na komputerze: zakładka 📱 Telefon → „Odbierz z telefonu (kamera)”.'),
      h('li', {}, 'Tutaj: „Pokaż kody QR”. Ustaw jasność ekranu na maksimum.'),
      h('li', {}, 'Trzymaj telefon 20–30 cm przed kamerą laptopa. Kody zmieniają się same.'),
      h('li', {}, 'Gdy PC pokaże listę i zapiszesz ją w budżecie – naciśnij tu „✓ PC odebrał”.'))));
}

async function pokazKodyWysylki(pozycje) {
  const partia = pozycje.map((p) => [p.u, p.r]);
  let czesci;
  try {
    const tekst = await zakoduj(paczkaDoWyslania(pozycje));
    czesci = podzielNaCzesci(tekst, ROZMIARY_QR[S.ustaw.rozmiar] || 220);
  } catch (e) {
    alert('Ta przeglądarka nie obsługuje kompresji danych (CompressionStream). Zaktualizuj system/przeglądarkę.\n\n' + e);
    return;
  }
  // Zapamiętaj, że te pozycje były już pokazane w kodach (wpływa na sposób usuwania)
  for (const p of pozycje) if (p.q !== p.r) await zapiszPozycje({ ...p, q: p.r });

  let idx = 0, pauza = false, timer = null, blokada = null;
  const canvas = h('canvas', {});
  const licznik = h('div', { class: 'qr-licznik' });
  const kropki = h('div', { class: 'kropki' });
  const btnPauza = h('button', { class: 'btn szary maly', onclick: () => { pauza = !pauza; btnPauza.textContent = pauza ? '▶ Wznów' : '⏸ Pauza'; } }, '⏸ Pauza');
  const pokaz = (i) => {
    idx = (i + czesci.length) % czesci.length;
    rysujQR(canvas, czesci[idx]);
    licznik.textContent = czesci.length > 1 ? `Kod ${idx + 1} z ${czesci.length}` : 'Jeden kod – pokaż go kamerze';
    kropki.replaceChildren(...czesci.map((_, j) => h('span', { class: j === idx ? 'teraz' : '' })));
  };

  const kopiuj = async () => {
    const tekst = czesci.join('\n');
    try { await navigator.clipboard.writeText(tekst); toast('Skopiowano – wklej na PC: „Wklej kod tekstowy”'); } catch (e) {
      otworzNakladke('Kod tekstowy', h('div', {}, h('p', { class: 'opis' }, 'Zaznacz i skopiuj całość:'),
        h('textarea', { class: 'tekst-kod', readonly: true }, tekst)));
    }
  };

  const zawartosc = h('div', {},
    h('div', { class: 'qr-box' }, canvas), licznik, kropki,
    czesci.length > 1 ? h('div', { class: 'przyciski-trzy' },
      h('button', { class: 'btn szary maly', onclick: () => pokaz(idx - 1), 'aria-label': 'Poprzedni kod' }, '◀'),
      btnPauza,
      h('button', { class: 'btn szary maly', onclick: () => pokaz(idx + 1), 'aria-label': 'Następny kod' }, '▶')) : null,
    h('button', {
      class: 'btn zielony', onclick: async () => {
        if (!confirm('Czy PC odebrał dane i zapisałeś je w budżecie?')) return;
        await oznaczPrzeniesione(partia);
        zamknij();
        toast('Oznaczono jako przeniesione ✓');
      },
    }, '✓ PC odebrał – oznacz jako przeniesione'),
    h('button', { class: 'btn obrys maly', onclick: kopiuj }, '📋 Kopiuj jako tekst (bez kamery)'),
    h('p', { class: 'male' }, 'Jeśli PC nie łapie kodów: zwiększ jasność, zmień odległość albo w Ustawieniach wybierz większe/mniejsze kody.'));

  const zamknij = otworzNakladke('Wyślij do PC', zawartosc, {
    jasna: true,
    przyZamknieciu: () => {
      clearInterval(timer);
      if (blokada) blokada.release().catch(() => {});
      przejdz(S.widok);
    },
  });
  pokaz(0);
  if (czesci.length > 1) timer = setInterval(() => { if (!pauza) pokaz(idx + 1); }, TEMPA_QR[S.ustaw.tempo] || 1300);
  // Nie wygaszaj ekranu w trakcie pokazywania kodów (jeśli przeglądarka to obsługuje)
  try { if ('wakeLock' in navigator) blokada = await navigator.wakeLock.request('screen'); } catch (e) { /* brak obsługi */ }
}

async function oznaczPrzeniesione(partia) {
  for (const [u, r] of partia) {
    const p = S.pozycje.find((x) => x.u === u);
    if (!p) continue;
    if (p.x && p.r === r) { await usunPozycjeCalkiem(u); continue; }
    if ((p.s || 0) < r) await zapiszPozycje({ ...p, s: r });
  }
  await przytnijHistorie();
}

// ============================================================================
// Skaner QR (aparat telefonu) – pobieranie konfiguracji z PC
// ============================================================================

async function skanujKonfiguracje() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Ta przeglądarka nie daje dostępu do aparatu.');
    return;
  }
  const video = h('video', { playsinline: true, muted: true, autoplay: true });
  video.muted = true;
  const pasek = h('div', {});
  const status = h('p', { class: 'opis' }, 'Skieruj aparat na kod QR na ekranie komputera.');
  const zawartosc = h('div', {},
    h('div', { class: 'kamera' }, video, h('div', { class: 'ramka' })),
    h('div', { class: 'pasek' }, pasek), status);

  let strumien = null, dziala = true;
  const zamknij = otworzNakladke('Pobierz z PC', zawartosc, {
    przyZamknieciu: () => {
      dziala = false;
      if (strumien) strumien.getTracks().forEach((t) => t.stop());
      przejdz(S.widok);
    },
  });

  try {
    strumien = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (e) {
    status.textContent = 'Brak dostępu do aparatu. Zezwól stronie na użycie aparatu w ustawieniach przeglądarki. (' + e.name + ')';
    status.classList.add('blad');
    return;
  }
  if (!dziala) { strumien.getTracks().forEach((t) => t.stop()); return; }
  video.srcObject = strumien;
  await video.play().catch(() => {});

  const zb = new Zbieracz();
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const petla = async () => {
    if (!dziala) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const sk = Math.min(1, 900 / Math.max(video.videoWidth, video.videoHeight));
      c.width = Math.round(video.videoWidth * sk);
      c.height = Math.round(video.videoHeight * sk);
      ctx.drawImage(video, 0, 0, c.width, c.height);
      const obraz = ctx.getImageData(0, 0, c.width, c.height);
      const kod = jsQR(obraz.data, c.width, c.height, { inversionAttempts: 'dontInvert' });
      if (kod && kod.data) {
        if (!kod.data.startsWith(PREFIKS + ':')) {
          status.textContent = 'To nie jest kod z aplikacji budżetowej.';
        } else if (zb.dodaj(kod.data)) {
          if (navigator.vibrate) navigator.vibrate(30);
          pasek.style.width = `${Math.round(100 * zb.czesci.size / zb.liczba)}%`;
          status.textContent = `Odebrano ${zb.czesci.size} z ${zb.liczba} części…`;
          if (zb.kompletne) {
            try {
              const cfg = await zdekoduj(zb.tekst());
              if (cfg.f !== FORMAT_KONFIGURACJI) throw new Error('to nie jest kod konfiguracji');
              await zapiszKonfiguracje(cfg);
              zamknij();
              toast(`Pobrano: ${cfg.k.length} kategorii, ${cfg.a.length} kont ✓`, 3000);
            } catch (e) {
              status.textContent = 'Błąd odczytu: ' + e.message + '. Spróbuj ponownie.';
              zb.reset();
            }
            return;
          }
        }
      }
    }
    setTimeout(petla, 120);
  };
  petla();
}

async function zapiszKonfiguracje(cfg) {
  const czysta = { ts: cfg.ts, k: cfg.k, a: cfg.a };
  await kvSet('cfg', czysta);
  ustawKonfiguracje(czysta);
}

// ============================================================================
// Widok: Ustawienia
// ============================================================================

function widokUstawienia(m) {
  // Urządzenie
  const nazwa = h('input', { value: S.urzadzenie.nazwa, placeholder: 'np. Bartek albo Ula', maxlength: 30 });
  nazwa.addEventListener('change', async () => {
    S.urzadzenie.nazwa = nazwa.value.trim();
    await kvSet('urzadzenie', S.urzadzenie);
    toast('Zapisano nazwę');
  });
  m.append(h('div', { class: 'karta' },
    h('h2', {}, 'Ten telefon'),
    h('p', { class: 'opis' }, 'Nazwa pojawi się w historii przesłań na PC, żebyście wiedzieli, z czyjego telefonu przyszły dane.'),
    h('div', { class: 'pole' }, h('label', {}, 'Nazwa telefonu'), nazwa)));

  // Konfiguracja
  m.append(h('div', { class: 'karta' },
    h('h2', {}, 'Kategorie i konta'),
    S.cfg
      ? h('p', { class: 'opis' }, `Pobrano ${S.cfg.ts}: ${S.cfg.k.length} kategorii, ${S.cfg.a.length} kont.`)
      : h('div', { class: 'info' }, 'Jeszcze nie pobrano. Bez tego nie da się zapisywać wydatków.'),
    h('p', { class: 'opis' }, 'Na komputerze: 📱 Telefon → „Wyślij kategorie i konta na telefon”. '
      + 'Powtórz po każdej zmianie kategorii lub kont na PC.'),
    h('button', { class: 'btn', onclick: skanujKonfiguracje }, '📷 Pobierz kategorie i konta z PC')));

  // Kody QR
  const wybor = (klucz, opcje) => {
    const s = h('select', {}, ...opcje.map(([v, et]) => h('option', { value: v, selected: S.ustaw[klucz] === v }, et)));
    s.addEventListener('change', async () => { S.ustaw[klucz] = s.value; await kvSet('ustaw', S.ustaw); toast('Zapisano'); });
    return s;
  };
  m.append(h('div', { class: 'karta' },
    h('h2', {}, 'Kody QR przy wysyłaniu'),
    h('div', { class: 'dwa' },
      h('div', { class: 'pole' }, h('label', {}, 'Ilość danych w kodzie'),
        wybor('rozmiar', [['maly', 'Mało (łatwiej czytać)'], ['sredni', 'Średnio'], ['duzy', 'Dużo (mniej kodów)']])),
      h('div', { class: 'pole' }, h('label', {}, 'Zmiana kodu co'),
        wybor('tempo', [['wolno', '2 s'], ['normalnie', '1,3 s'], ['szybko', '0,8 s']]))),
    h('p', { class: 'male' }, 'Jeśli kamera laptopa słabo łapie kody – wybierz „Mało” i „2 s” albo przybliż telefon.')));

  // Dane
  const zdj = S.pozycje.filter((p) => p.f).length;
  const daneKarta = h('div', { class: 'karta' },
    h('h2', {}, 'Dane na telefonie'),
    h('p', { class: 'opis' }, `${S.pozycje.length} pozycji w historii, ${oczekujace().length} do wysłania, ${zdj} ze zdjęciem. `
      + 'Dane są zapisane wyłącznie na tym telefonie.'),
  );
  const trwalosc = h('p', { class: 'male' });
  daneKarta.append(trwalosc);
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((t) => {
      trwalosc.textContent = t ? '✓ Przeglądarka oznaczyła dane jako trwałe.'
        : (czyZainstalowana() ? 'Aplikacja jest na ekranie głównym – dane są bezpieczne.'
          : '⚠ Dodaj aplikację do ekranu głównego – inaczej przeglądarka może skasować dane po kilku dniach nieużywania.');
    });
  }
  daneKarta.append(
    h('button', {
      class: 'btn szary maly', onclick: async () => {
        const wys = S.pozycje.filter((p) => statusPozycji(p) === 'wyslana');
        if (!wys.length) { toast('Brak przeniesionych pozycji'); return; }
        if (!confirm(`Usunąć z telefonu ${wys.length} pozycji już przeniesionych na PC? (W budżecie na PC zostają.)`)) return;
        for (const p of wys) await usunPozycjeCalkiem(p.u);
        przejdz('ustawienia');
        toast('Wyczyszczono przeniesione');
      },
    }, '🧹 Usuń przeniesione z historii'),
    h('button', {
      class: 'btn czerwony maly', onclick: async () => {
        const n = oczekujace().length;
        const ostrz = n ? `\n\nUWAGA: ${n} pozycji NIE zostało jeszcze wysłanych na PC – przepadną!` : '';
        if (prompt(`Usunąć WSZYSTKIE dane z tego telefonu (pozycje, zdjęcia, kategorie)?${ostrz}\n\nWpisz USUŃ, aby potwierdzić.`) !== 'USUŃ') return;
        await DB.wyczysc('pozycje'); await DB.wyczysc('zdjecia'); await DB.wyczysc('kv');
        location.reload();
      },
    }, '⚠️ Usuń wszystkie dane z telefonu'),
  );
  m.append(daneKarta);

  m.append(h('div', { class: 'karta' },
    h('h2', {}, 'O aplikacji'),
    h('p', { class: 'opis' }, `Budżet – wersja mobilna ${WERSJA}. Działa offline. Nie wysyła żadnych danych do internetu – `
      + 'jedyna droga danych na komputer to kody QR, które sam pokazujesz.'),
    h('p', { class: 'male' }, `Id telefonu: ${S.urzadzenie.id}`)));
}

// ============================================================================
// Instalacja (ekran główny) + start
// ============================================================================

function czyZainstalowana() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function banerInstalacji() {
  if (czyZainstalowana()) return;
  const ukryty = await kvGet('banerUkryty', 0);
  if (Date.now() - ukryty < 3 * 24 * 3600 * 1000) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const b = $('#baner-instalacji');
  b.replaceChildren(
    h('button', { class: 'zamknij-baner', onclick: async () => { b.hidden = true; S.banerInstalacji = false; await kvSet('banerUkryty', Date.now()); } }, '✕'),
    h('b', {}, 'Dodaj do ekranu głównego'),
    ios ? ' (Udostępnij → „Do ekranu początkowego”)' : ' (menu ⋮ → „Zainstaluj aplikację”)',
    ' – inaczej przeglądarka może skasować dane.');
  S.banerInstalacji = true;
  b.hidden = !['dodaj', 'ustawienia'].includes(S.widok);
}

async function start() {
  try {
    await DB.otworz();
  } catch (e) {
    $('#widok').replaceChildren(h('div', { class: 'info blad' },
      'Nie udało się otworzyć pamięci przeglądarki. Jeśli używasz trybu prywatnego – wyłącz go. ' + e));
    return;
  }
  S.pozycje = await DB.wszystkie('pozycje');
  ustawKonfiguracje(await kvGet('cfg', null));
  S.ustaw = { ...S.ustaw, ...(await kvGet('ustaw', {})) };
  S.ostatnie = { ...S.ostatnie, ...(await kvGet('ostatnie', {})) };
  S.urzadzenie = await kvGet('urzadzenie', null);
  if (!S.urzadzenie) {
    S.urzadzenie = { nazwa: '', id: noweId() };
    await kvSet('urzadzenie', S.urzadzenie);
  }
  await przytnijHistorie();

  // Poproś przeglądarkę o trwałe przechowywanie danych
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  document.querySelectorAll('nav.dol button').forEach((b) => b.addEventListener('click', () => przejdz(b.dataset.widok)));
  przejdz(S.cfg ? 'dodaj' : 'ustawienia');
  banerInstalacji();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
