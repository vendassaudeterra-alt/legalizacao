// Leitura do certificado de matrícula (DUA) por OCR no próprio aparelho.
// Usa o Tesseract.js e corrige as trocas típicas do OCR com o formato conhecido de cada campo.
var OcrDua = (function () {
  "use strict";
  var worker = null, curProg = null, fila = Promise.resolve();
  function enfileirar(fn) { var p = fila.then(fn, fn); fila = p.catch(function () {}); return p; }

  function getWorker() {
    if (!worker) worker = Tesseract.createWorker("por", 1, { logger: function (m) { if (curProg && m.status === "recognizing text") curProg(m.progress); } });
    return worker;
  }

  // Imagem preparada: ~2400 px, canal mais escuro (tira o fundo verde do cartão) e, se bin, preto/branco por Otsu.
  function prep(src, bin, maxSide) {
    var W = src.width, H = src.height, k = (maxSide || 2400) / Math.max(W, H);
    if (k > 4) k = 4;
    var c = document.createElement("canvas"); c.width = Math.round(W * k); c.height = Math.round(H * k);
    var x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, c.width, c.height);
    var d = x.getImageData(0, 0, c.width, c.height), p = d.data, hist = new Array(256).fill(0), i;
    for (i = 0; i < p.length; i += 4) { var g = Math.min(p[i], p[i + 1], p[i + 2]); p[i] = p[i + 1] = p[i + 2] = g; hist[g]++; }
    if (bin) {
      var tot = p.length / 4, sum = 0, t; for (t = 0; t < 256; t++) sum += t * hist[t];
      var sB = 0, wB = 0, best = 0, th = 128;
      for (t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; var wF = tot - wB; if (!wF) break; sB += t * hist[t]; var mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; th = t; } }
      for (i = 0; i < p.length; i += 4) { var b = p[i] > th ? 255 : 0; p[i] = p[i + 1] = p[i + 2] = b; }
    }
    x.putImageData(d, 0, 0);
    return c;
  }

  // Endireita o cartão (procura o ângulo em que as linhas de texto ficam mais nítidas) e recorta-o do fundo.
  function otsu(hist, tot) {
    var sum = 0, t; for (t = 0; t < 256; t++) sum += t * hist[t];
    var sB = 0, wB = 0, best = 0, th = 128;
    for (t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; var wF = tot - wB; if (!wF) break; sB += t * hist[t]; var mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; th = t; } }
    return th;
  }
  function normalize(src) {
    var W = src.width, H = src.height, k = 900 / Math.max(W, H);
    var sw = Math.round(W * k), sh = Math.round(H * k);
    var sm = document.createElement("canvas"); sm.width = sw; sm.height = sh;
    var sx = sm.getContext("2d", { willReadFrequently: true }); sx.drawImage(src, 0, 0, sw, sh);
    var D = sx.getImageData(0, 0, sw, sh).data, g = new Uint8Array(sw * sh), i;
    for (i = 0; i < sw * sh; i++) g[i] = Math.min(D[i * 4], D[i * 4 + 1], D[i * 4 + 2]);
    // pontos de aresta horizontal (topo e base das letras); um fundo liso não tem
    var pts = [];
    for (var y = 1; y < sh; y++) for (var x = 0; x < sw; x++) { var q = y * sw + x; if (Math.abs(g[q] - g[q - sw]) > 45) pts.push(q); }
    if (pts.length < 200) return src;
    var cx = sw / 2, cy = sh / 2, bestA = 0, bestV = -1, a;
    function score(a) {
      var r = a * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r), rows = new Float32Array(sh * 2 + 2), j, v = 0;
      for (j = 0; j < pts.length; j++) { var px = pts[j] % sw - cx, py = (pts[j] / sw | 0) - cy, yy = Math.round(-px * sn + py * cs + sh); if (yy >= 0 && yy < rows.length) rows[yy]++; }
      for (j = 0; j < rows.length; j++) v += rows[j] * rows[j];
      return v;
    }
    for (a = -10; a <= 10.01; a += 0.5) { var v = score(a); if (v > bestV) { bestV = v; bestA = a; } }
    for (a = bestA - 0.4; a <= bestA + 0.41; a += 0.1) { var v2 = score(a); if (v2 > bestV) { bestV = v2; bestA = a; } }
    if (Math.abs(bestA) < 0.3) { src._angulo = 0; return src; }
    // imagem inteira endireitada, com o fundo preenchido a branco
    var rad = -bestA * Math.PI / 180, c2 = Math.abs(Math.cos(rad)), s2 = Math.abs(Math.sin(rad));
    var big = document.createElement("canvas");
    big.width = Math.round(W * c2 + H * s2); big.height = Math.round(W * s2 + H * c2);
    var bx = big.getContext("2d");
    bx.fillStyle = "#fff"; bx.fillRect(0, 0, big.width, big.height);
    bx.translate(big.width / 2, big.height / 2); bx.rotate(rad); bx.drawImage(src, -W / 2, -H / 2);
    big._angulo = Math.round(bestA * 10) / 10;
    return big;
  }

  function recorte(c, bb) {
    try { return crop(c, bb, Math.min(2, 900 / Math.max(1, bb.x1 - bb.x0))).toDataURL("image/jpeg", 0.85); } catch (e) { return null; }
  }
  function crop(c, bb, scale) {
    var mx = (bb.x1 - bb.x0) * 0.06 + 6, my = (bb.y1 - bb.y0) * 0.35 + 6;
    var x0 = Math.max(0, bb.x0 - mx), y0 = Math.max(0, bb.y0 - my), w = Math.min(c.width, bb.x1 + mx) - x0, h = Math.min(c.height, bb.y1 + my) - y0;
    var o = document.createElement("canvas"); o.width = Math.round(w * scale); o.height = Math.round(h * scale);
    var x = o.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, o.width, o.height); x.imageSmoothingQuality = "high";
    x.drawImage(c, x0, y0, w, h, 0, 0, o.width, o.height);
    return o;
  }

  // Devolve { text, words:[{text,bbox}] }
  function ocr(canvas, opts, onProgress) {
    opts = opts || {};
    return getWorker().then(function (w) {
      curProg = onProgress || null;
      return w.setParameters({ tessedit_pageseg_mode: opts.psm || "11", preserve_interword_spaces: "1", tessedit_char_whitelist: opts.white || "" })
        .then(function () { return w.recognize(canvas, {}, { text: true, blocks: true }); });
    }).then(function (r) {
      var words = [];
      (r.data.blocks || []).forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) { (l.words || []).forEach(function (wd) { words.push({ text: wd.text, bbox: wd.bbox }); }); }); }); });
      return { text: r.data.text || "", words: words, conf: r.data.confidence || 0 };
    });
  }

  // ---------- correções ----------
  var TO_L = { "0": "O", "1": "I", "2": "Z", "7": "Z", "5": "S", "8": "B", "6": "G", "4": "A" };
  var TO_D = { "O": "0", "Q": "0", "D": "0", "U": "0", "I": "1", "L": "1", "J": "1", "Z": "2", "S": "5", "B": "8", "G": "6", "A": "4", "T": "7" };
  function fix(ch, want) {
    if (want === "L") return /[A-Z]/.test(ch) ? ch : TO_L[ch] || null;
    return /\d/.test(ch) ? ch : TO_D[ch] || null;
  }
  // Formatos portugueses e a época em que se usaram
  var FMTS = [
    { f: "DDDDLL", de: 1992, ate: 2005 },
    { f: "DDLLDD", de: 2005, ate: 2020 },
    { f: "LLDDDD", de: 1937, ate: 1992 },
    { f: "LLDDLL", de: 2020, ate: 2100 }
  ];
  function plate(raw, ano) {
    var s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (s.length !== 6) return null;
    var best = null;
    FMTS.forEach(function (F) {
      var out = "", subs = 0;
      for (var i = 0; i < 6; i++) { var c = fix(s[i], F.f[i]); if (!c) return; if (c !== s[i]) subs++; out += c; }
      var score = subs * 2 + (ano && (ano < F.de - 1 || ano > F.ate + 1) ? 5 : 0);
      if (!best || score < best.score) best = { v: out.slice(0, 2) + "-" + out.slice(2, 4) + "-" + out.slice(4), score: score };
    });
    return best && best.v;
  }

  var MARCAS = ["MERCEDES-BENZ", "MITSUBISHI FUSO", "LAND ROVER", "ALFA ROMEO", "MITSUBISHI", "TOYOTA", "NISSAN", "ISUZU", "MAZDA", "SUZUKI", "HONDA", "DAIHATSU", "SUBARU",
    "FORD", "RENAULT", "PEUGEOT", "CITROEN", "FIAT", "IVECO", "MERCEDES", "VOLKSWAGEN", "OPEL", "MAN", "DAF", "SCANIA", "VOLVO", "HYUNDAI", "KIA", "DACIA", "SEAT", "SKODA",
    "BMW", "AUDI", "JEEP", "PIAGGIO", "TATA", "MAXUS", "LDV", "UMM", "SSANGYONG", "MULTICAR", "GOUPIL", "AIXAM", "LIGIER"];
  // Prefixos do n.º de quadro (WMI) por marca
  var WMI = { MITSUBISHI: ["JMB", "JMA", "JMY", "JMF", "MMB", "MMC", "XMC"], TOYOTA: ["JTE", "JTF", "JTD", "JTN", "SB1", "MHF", "AHT"], NISSAN: ["JN1", "JN8", "VSK", "SJN", "VWA"],
    ISUZU: ["JAA", "JAL", "MPA", "JAC"], MAZDA: ["JMZ", "JM0"], SUZUKI: ["JSA", "VSE", "TSM"], HONDA: ["JHM", "SHH"], FORD: ["WF0", "NM0"], RENAULT: ["VF1", "VF6", "VF8"],
    PEUGEOT: ["VF3", "VR3"], CITROEN: ["VF7", "VR7"], FIAT: ["ZFA", "ZFC"], IVECO: ["ZCF"], MERCEDES: ["WDB", "WDF", "WD3", "W1V", "WDD", "VSA"], "MERCEDES-BENZ": ["WDB", "WDF", "WD3", "W1V", "WDD", "VSA"],
    VOLKSWAGEN: ["WV1", "WV2", "WVW", "WVG"], OPEL: ["W0L", "W0V"], MAN: ["WMA"], DAF: ["XLR"], SCANIA: ["YS2"], VOLVO: ["YV2", "YV1"], HYUNDAI: ["KMF", "KMH", "NLH"], KIA: ["KNA", "KNE"],
    DACIA: ["UU1"], SEAT: ["VSS"], SKODA: ["TMB"], BMW: ["WBA"], AUDI: ["WAU"] };
  var ANO = "ABCDEFGHJKLMNPRSTVWXY123456789"; // 10.º carácter: A = 1980 ... 9 = 2009, depois recomeça (A = 2010)
  function anoOk(c, ano) { if (!ano) return true; var i = ANO.indexOf(c); if (i < 0) return false; var y = 1980 + i; return Math.abs(y - ano) <= 2 || Math.abs(y + 30 - ano) <= 2; }
  function vinFrom(raw, marca, ano) {
    var s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[IOQ]/g, function (c) { return c === "I" ? "1" : "0"; });
    var cands = [];
    if (s.length === 17) cands.push(s);
    else if (s.length === 18) for (var i = 0; i < 18; i++) cands.push(s.slice(0, i) + s.slice(i + 1));
    else return null;
    var best = null;
    cands.forEach(function (c) {
      var a = c.split(""), score = 0;
      // série: as 4 últimas posições são algarismos
      for (var k = 13; k < 17; k++) { if (!/\d/.test(a[k])) { var d = TO_D[a[k]]; if (d) { a[k] = d; score += 1; } else score += 5; } }
      // posições 12 e 13: um D, O, Q ou U no meio da série é quase sempre um zero
      for (var q = 11; q <= 12; q++) if (/[DOQU]/.test(a[q])) a[q] = "0";
      var w = WMI[marca] || [];
      if (w.length) {
        var pre = a.slice(0, 3).join(""), bestW = null, bd = 9;
        w.forEach(function (x) { var dd = 0; for (var j = 0; j < 3; j++) if (x[j] !== pre[j]) dd++; if (dd < bd) { bd = dd; bestW = x; } });
        if (bd === 1) { a[0] = bestW[0]; a[1] = bestW[1]; a[2] = bestW[2]; } else if (bd > 1) score += 3;
      }
      if (!anoOk(a[9], ano)) score += 4;
      var v = a.join("");
      if (!best || score < best.score) best = { v: v, score: score };
    });
    return best ? best.v : null;
  }
  function num(v) { if (v == null) return null; if (/^\s*[Xx×]\s*$/.test(v)) return null; var s = String(v).replace(/[OoQD]/g, "0").replace(/[Il|]/g, "1").replace(/[^\d.,]/g, "").replace(",", "."); if (!s) return null; var n = Number(s); return isFinite(n) ? n : null; }
  function m(t, re) { return t.match(re); }
  function clean(v) { if (!v) return null; v = v.replace(/\s{2,}/g, " ").trim(); var core = v.replace(/[^A-Za-z0-9×]/g, ""); return (!core || /^[XxK×]{1,3}$/.test(core)) ? null : v; }

  // ---------- leitura dos campos ----------
  function datasFrente(U) {
    var todas = [], re = /(\d{4})[-.\s](\d{2})[-.\s](\d{2})/g, a;
    while ((a = re.exec(U))) { var d = a[1] + "-" + a[2] + "-" + a[3]; if (todas.indexOf(d) < 0) todas.push(d); }
    var emis = U.match(/EMISS\D{0,30}(\d{4})[-.\s](\d{2})[-.\s](\d{2})/), e = emis ? emis[1] + "-" + emis[2] + "-" + emis[3] : null;
    todas.sort();
    if (!e && todas.length >= 2) e = todas[todas.length - 1]; // a emissão é a mais recente
    return todas.filter(function (d) { return d !== e; }).slice(0, 2);
  }
  function matricula(U, ano) {
    var re = /(?:^|[^0-9A-Z])([0-9A-Z]{2})\s?[-–.]\s?([0-9A-Z]{2})\s?[-–.]\s?([0-9A-Z]{2})/g, a;
    while ((a = re.exec(U))) {
      if (/^\d{4}$/.test(a[1] + a[2]) && Number(a[1] + a[2]) > 1900 && Number(a[1] + a[2]) < 2100) continue; // é uma data
      var p = plate(a[1] + a[2] + a[3], ano); if (p) return p;
    }
    return null;
  }

  function parseVerso(U) {
    U = U.toUpperCase().replace(/[|]/g, " ");
    var r = {}, x;
    for (var i = 0; i < MARCAS.length; i++) { var re = new RegExp("\\b" + MARCAS[i].replace("-", "[- ]?") + "\\b"); if (re.test(U)) { r.marca = MARCAS[i]; break; } }
    if (!r.marca && (x = m(U, /\bD[.,]\s*3?1\s+([A-Z][A-Z\- ]{1,30})/))) r.marca = clean(x[1].split(/\s{2,}|\n/)[0]);
    if ((x = m(U, /\bD[.,]\s*2\s+([^\n]{2,40})/))) r.modelo = clean(x[1].split(/\s{3,}/)[0]);
    // L 200 / L 300 da Mitsubishi lidos como 1300
    if (r.modelo && r.marca === "MITSUBISHI") r.modelo = r.modelo.replace(/^[1lI|]\s?([2-4]00)\b/, "L $1");
    // D.3 que não seja a marca lida por engano
    (U.match(/\bD[.,]\s*3\s+([^\n]{1,40})/g) || []).forEach(function (l) { var v = clean(l.replace(/\bD[.,]\s*3\s+/, "").split(/\s{3,}/)[0]); if (v && v !== r.marca && !r.denominacao_comercial) r.denominacao_comercial = v; });
    if ((x = m(U, /F[.,]\s*1\s*\/\s*F[.,]\s*2\s+([X0-9]+)\s*\/\s*([X0-9]+)/))) { r.peso_bruto_tecnico_kg = num(x[1]); r.peso_bruto_kg = num(x[2]); }
    if (!r.peso_bruto_kg && (x = m(U, /F[.,]\s*2\s+([0-9]{3,6})/))) r.peso_bruto_kg = num(x[1]);
    if ((x = m(U, /F[.,]\s*3\s+([0-9]{3,6})/))) r.peso_conjunto_kg = num(x[1]);
    if ((x = m(U, /(?:^|\s)G\s+(\d{4,5})\b/m))) r.tara_kg = num(x[1]);
    var cat = m(U, /\b(LIGEIRO|PESADO)\b/); if (cat) r.categoria = cat[1] === "LIGEIRO" ? "Ligeiro" : "Pesado";
    var tipo = m(U, /\b(MERCADORIAS|PASSAGEIROS|MISTO|ESPECIAL|REBOQUE)\b/); if (tipo) r.tipo = tipo[1][0] + tipo[1].slice(1).toLowerCase();
    if ((x = m(U, /\b[J1I][.,]\s*3\s+([A-Z][A-ZÇÃÕÁÉÍÓÚÂÊÔ ]{2,30})/))) r.carrocaria = clean(x[1].split(/\s{2,}/)[0]);
    if ((x = m(U, /K[.,]\s*1\s+(\d{6,})/))) r.homologacao = x[1];
    else if ((x = m(U, /\bK\s+([A-Z0-9*]{5,})/))) r.homologacao = clean(x[1]);
    if ((x = m(U, /N[.,]\s*5\s+(\d{3,5})\s*[:;.]\s*(\d{3,5})(?:\s*[:;.]\s*(\d{3,5}))?/)) || (x = m(U, /\b(\d{4,5})\s*[:;]\s*(\d{4,5})(?:\s*[:;]\s*(\d{4,5}))?/))) {
      r.eixo_frente_max_kg = num(x[1]); r.eixo_tras_max_kg = num(x[2]); r.numero_eixos = x[3] ? 3 : 2;
    }
    if ((x = m(U, /O[.,]\s*1\s+(\d{3,7})/))) r.reboque_travado_kg = num(x[1]);
    if ((x = m(U, /O[.,]\s*2\s+(\d{3,7})/))) r.reboque_nao_travado_kg = num(x[1]);
    if ((x = m(U, /P[.,]\s*1\s+(\d{3,5})/))) r.cilindrada_cm3 = num(x[1]);
    if ((x = m(U, /P[.,]\s*2\s+(\d{1,3}[.,]\d|\d{1,3})\b/))) r.potencia_kw = num(x[1]);
    if ((x = m(U, /P[.,]\s*3\s+([A-ZÓ]{3,})/)) || (x = m(U, /\b(GAS[OÓ]LEO|GASOLINA|EL[EÉ]TRICO|H[IÍ]BRIDO|GPL)\b/))) {
      var c = x[1].replace("Ó", "O").replace("É", "E").replace("Í", "I");
      r.combustivel = /GASOL[EI]O|DIESEL/.test(c) ? "Gasóleo" : /GASOLINA/.test(c) ? "Gasolina" : /ELE/.test(c) ? "Elétrico" : /HIBR/.test(c) ? "Híbrido" : /GPL/.test(c) ? "GPL" : "Outro";
    }
    if ((x = m(U, /(?:^|\s)R\s+([A-Z][A-ZÇÃÕ ]{2,30})/m))) r.cor = clean(x[1].split(/\s{2,}|\n/)[0]);
    if ((x = m(U, /S\W?[.,]\s*1\s+(\d{1,3})\b/))) r.lugares_sentados = num(x[1]);
    if ((x = m(U, /S\W?[.,]\s*2\s+(\d{1,3})\b/))) r.lugares_pe = num(x[1]);
    var pn = [], pre = /(\d{3})\s*\/?\s*(\d{2})?\s*R\s*(\d{2}(?:[.,]5)?)(\s*C\b)?/g, pa;
    while ((pa = pre.exec(U))) pn.push(pa[1] + (pa[2] ? "/" + pa[2] : "") + " R " + pa[3] + (pa[4] ? " C" : ""));
    if (pn[0]) r.pneus_frente = pn[0];
    if (pn[1]) r.pneus_tras = pn[1]; else if (pn[0]) r.pneus_tras = pn[0];
    if ((x = m(U, /\b[Z2][.,]\s*\d\s+([A-Z][^\n]{5,80})/))) r.observacoes = clean(x[1]).replace(/DB\(AJA/, "DB(A)A").replace(/\s=\s/, " = ");
    return r;
  }

  // Coerência entre campos: o que não bate certo fica em branco para o cliente preencher.
  function check(r) {
    var avisos = [];
    if (r.tara_kg && r.peso_bruto_kg && r.tara_kg >= r.peso_bruto_kg) { avisos.push("tara"); delete r.tara_kg; }
    var lim = (r.categoria === "Pesado" || (r.peso_bruto_kg && r.peso_bruto_kg > 3500)) ? 60000 : 3500;
    ["reboque_travado_kg", "reboque_nao_travado_kg", "eixo_frente_max_kg", "eixo_tras_max_kg", "peso_bruto_kg", "tara_kg", "peso_conjunto_kg"].forEach(function (k) {
      var l = k === "peso_conjunto_kg" ? lim * 2.5 : lim;
      if (r[k] != null && (r[k] < 100 || r[k] > l)) { avisos.push(k); delete r[k]; }
    });
    if (r.eixo_frente_max_kg && r.eixo_tras_max_kg && r.peso_bruto_kg && r.eixo_frente_max_kg + r.eixo_tras_max_kg < r.peso_bruto_kg) avisos.push("pesos por eixo");
    if (r.cilindrada_cm3 && (r.cilindrada_cm3 < 500 || r.cilindrada_cm3 > 20000)) delete r.cilindrada_cm3;
    if (r.potencia_kw && (r.potencia_kw < 10 || r.potencia_kw > 800)) delete r.potencia_kw;
    if (r.lugares_sentados && (r.lugares_sentados < 1 || r.lugares_sentados > 60)) delete r.lugares_sentados;
    if (!r.categoria && r.peso_bruto_kg) r.categoria = r.peso_bruto_kg <= 3500 ? "Ligeiro" : "Pesado";
    r.avisos = avisos;
    return r;
  }

  function bitmap(file) {
    if (file instanceof HTMLCanvasElement || file instanceof HTMLImageElement || (window.ImageBitmap && file instanceof ImageBitmap)) return Promise.resolve(file);
    return createImageBitmap(file, { imageOrientation: "from-image" });
  }

  // Lê as duas faces. onProgress(0..1, texto) para mostrar o andamento.
  function ler(frente, verso, onProgress) { return enfileirar(function () { return lerAgora(frente, verso, onProgress); }); }
  function lerAgora(frente, verso, onProgress) {
    var N = 5, step = 0, bf, bv, gF, gV, F1, F2, V1, V2, r = {}, ano = null;
    function prog(t) { onProgress && onProgress(step / N, t); return function (p) { onProgress && onProgress((step + p) / N, t); }; }
    return Promise.all([bitmap(frente), bitmap(verso)]).then(function (b) {
      bf = normalize(b[0]); bv = normalize(b[1]);
      return ocr(prep(bf, true), {}, prog("A ler a frente..."));
    }).then(function (o) {
      F1 = o; step = 1;
      gF = prep(bf, false);
      return ocr(gF, {}, prog("A confirmar a matrícula..."));
    }).then(function (o) {
      F2 = o; step = 2;
      var datas = datasFrente((F1.text + "\n" + F2.text).toUpperCase());
      if (datas.length >= 2) { r.data_primeira_matricula = datas[0]; r.data_matricula = datas[1]; } else if (datas[0]) r.data_matricula = datas[0];
      ano = Number((r.data_primeira_matricula || r.data_matricula || "").slice(0, 4)) || null;
      // votação entre as duas leituras; em empate fica a de contraste
      var votos = {}, ordem = [];
      [F1.text, F2.text].forEach(function (t) { var p = matricula(t.toUpperCase(), ano); if (p) { if (!votos[p]) { votos[p] = 0; ordem.push(p); } votos[p]++; } });
      ordem.sort(function (a, b) { return votos[b] - votos[a]; });
      if (ordem[0]) r.matricula = ordem[0];
      // recorte da matrícula tal como está no certificado
      var wm = F2.words.concat(F1.words).filter(function (w) { return /^[0-9A-Z]{2}[-–.][0-9A-Z]{2}[-–.][0-9A-Z]{2}/i.test(w.text.trim()); })[0];
      if (wm) r._crop_mat = recorte(gF, wm.bbox);
      return ocr(prep(bv, true), {}, prog("A ler o verso..."));
    }).then(function (o) {
      V1 = o; step = 3;
      return { text: "" };
    }).then(function (o) {
      V2 = o; step = 4;
      // a leitura de contraste manda; a segunda preenche o que faltar
      var v = parseVerso(V1.text), v2 = parseVerso(V2.text);
      Object.keys(v2).forEach(function (k) { if (v[k] == null) v[k] = v2[k]; });
      Object.keys(v).forEach(function (k) { r[k] = v[k]; });
      // n.º de quadro: a palavra mais comprida, lida outra vez sozinha e ampliada
      var cand = V1.words.filter(function (w) { return w.text.replace(/[^A-Za-z0-9]/g, "").length >= 14; })
        .sort(function (a, b) { return b.text.length - a.text.length; })[0];
      if (!cand) return null;
      gV = prep(bv, false);
      r._crop_vin = recorte(gV, cand.bbox);
      return ocr(crop(gV, cand.bbox, 2), { psm: "7", white: "ABCDEFGHJKLMNPRSTUVWXYZ0123456789" }, prog("A ler o n.º de quadro..."))
        .then(function (o2) { return [o2.text, cand.text]; });
    }).then(function (vt) {
      step = 5;
      if (vt) { r.vin = vinFrom(vt[0], r.marca, ano) || vinFrom(vt[1], r.marca, ano); r._vin = vt; }
      onProgress && onProgress(1, "Leitura concluída");
      r._t = { f1: F1.text, f2: F2.text, v: V1.text, v2: V2.text };
      r._conf = Math.round((F1.conf + V1.conf) / 2);
      return check(r);
    });
  }


  // Ficha de inspeção: data, matrícula e, na facultativa, os pesos por eixo.
  function lerInspecao(file, onProgress) { return enfileirar(function () { return lerInspecaoAgora(file, onProgress); }); }
  function lerInspecaoAgora(file, onProgress) {
    return bitmap(file).then(function (b) { return ocr(prep(normalize(b), true), {}, onProgress); }).then(function (o) {
      var U = o.text.toUpperCase(), r = {}, datas = [], re = /(\d{2})[-\/.](\d{2})[-\/.](\d{4})|(\d{4})[-\/.](\d{2})[-\/.](\d{2})/g, a;
      while ((a = re.exec(U))) datas.push(a[3] ? a[3] + "-" + a[2] + "-" + a[1] : a[4] + "-" + a[5] + "-" + a[6]);
      datas = datas.filter(function (d) { var y = Number(d.slice(0, 4)); return y > 1990 && y < 2100; }).sort();
      if (datas.length) r.data = datas[datas.length - 1];
      r.matricula = matricula(U, null);
      r.e_inspecao = /INSPE[CÇ]|CENTRO DE INSPE|IMT|PER[IÍ]ODICA|FACULTATIVA|PESAGEM/.test(U);
      // pesos: linhas com EIXO e um número entre 200 e 20000
      var pesos = [];
      U.split("\n").forEach(function (l) {
        if (!/EIXO|EIX0|AXLE/.test(l)) return;
        var ns = (l.match(/\d[\d .]{2,6}/g) || []).map(function (n) { return Number(n.replace(/[ .]/g, "")); }).filter(function (n) { return n >= 200 && n <= 20000; });
        if (ns.length) pesos.push(ns[ns.length - 1]);
      });
      if (pesos.length < 2) {
        pesos = (U.match(/(\d[\d .]{2,6})\s*KG/g) || []).map(function (n) { return Number(n.replace(/[^\d]/g, "")); }).filter(function (n) { return n >= 200 && n <= 20000; });
      }
      if (pesos.length >= 2) { r.peso_frente = pesos[0]; r.peso_tras = pesos[1]; }
      r._t = o.text;
      return r;
    });
  }
  function preparar() { try { getWorker(); } catch (e) {} }

  return { normalize: normalize, ler: ler, lerInspecao: lerInspecao, preparar: preparar, parseVerso: parseVerso, check: check, plate: plate, vinFrom: vinFrom };
})();
