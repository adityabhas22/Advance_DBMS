/* ============================================================
   A Field Guide to the Database Engine
   Shared component library. Vanilla JS, no dependencies.

   Auto-wires declarative widgets on load:
     .mcq        multiple-choice question with feedback
     .flashcard  click-to-reveal self-test

   Exposes window.DBMS with helpers simulators can build on:
     DBMS.el(tag, attrs, kids)     DOM builder
     DBMS.svg(tag, attrs, kids)    SVG element builder
     DBMS.clamp(x, lo, hi)
     DBMS.rng(seed)                deterministic [0,1) generator
     DBMS.bindRange(input, out, f) live-update a readout from a slider
     DBMS.stepper(opts)            play / step / reset controller
   ============================================================ */
(function () {
  "use strict";
  const DBMS = (window.DBMS = window.DBMS || {});
  const LETTERS = ["A", "B", "C", "D", "E", "F"];

  /* ---------- tiny builders ---------- */
  DBMS.el = function (tag, attrs, kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  };
  const SVGNS = "http://www.w3.org/2000/svg";
  DBMS.svg = function (tag, attrs, kids) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  };

  DBMS.clamp = function (x, lo, hi) { return Math.max(lo, Math.min(hi, x)); };

  /* Mulberry32: small deterministic PRNG so simulators replay identically. */
  DBMS.rng = function (seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  DBMS.bindRange = function (input, out, fmt) {
    fmt = fmt || function (v) { return v; };
    const upd = function () { if (out) out.textContent = fmt(input.value); };
    input.addEventListener("input", upd);
    upd();
    return upd;
  };

  /* ---------- stepper: drives step-through simulators ----------
     opts = {
       controls: HTMLElement,   where to mount the buttons
       steps: Number | () => Number,   total steps (re-read each render)
       onRender: (i) => void,   draw state at step index i (0..steps)
       onReset: () => void,     optional, called before jumping to 0
       autoMs: Number,          play interval, default 800
       labels: {play,pause,step,back,reset}
     }
     returns { goto, next, prev, reset, play, pause, index }       */
  DBMS.stepper = function (opts) {
    const labels = Object.assign({ play: "Play", pause: "Pause", step: "Step", back: "Back", reset: "Reset" }, opts.labels || {});
    let i = 0, timer = null;
    const total = function () { return typeof opts.steps === "function" ? opts.steps() : opts.steps; };
    const render = function () { opts.onRender(i); btnState(); };
    const btnState = function () {
      backB.disabled = i <= 0;
      stepB.disabled = i >= total();
      if (i >= total()) pause();
    };
    function goto(n) { i = DBMS.clamp(n, 0, total()); render(); }
    function next() { if (i < total()) { i++; render(); } }
    function prev() { if (i > 0) { i--; render(); } }
    function reset() { pause(); if (opts.onReset) opts.onReset(); i = 0; render(); }
    function play() {
      if (timer) return;
      if (i >= total()) reset();
      playB.textContent = labels.pause; playB.dataset.playing = "1";
      timer = setInterval(function () { if (i >= total()) { pause(); return; } next(); }, opts.autoMs || 800);
    }
    function pause() { if (timer) { clearInterval(timer); timer = null; } playB.textContent = labels.play; delete playB.dataset.playing; }

    const playB = DBMS.el("button", { text: labels.play, onclick: function () { playB.dataset.playing ? pause() : play(); } });
    const backB = DBMS.el("button", { class: "ghost", text: labels.back, onclick: prev });
    const stepB = DBMS.el("button", { text: labels.step, onclick: next });
    const resetB = DBMS.el("button", { class: "ghost", text: labels.reset, onclick: reset });
    if (opts.controls) { opts.controls.append(playB, backB, stepB, resetB); }

    render();
    return { goto: goto, next: next, prev: prev, reset: reset, play: play, pause: pause, get index() { return i; } };
  };

  /* ---------- MCQ ---------- */
  function wireMCQ(box) {
    const ans = parseInt(box.getAttribute("data-answer"), 10);
    const opts = Array.prototype.slice.call(box.querySelectorAll(".mcq-opt"));
    if (!box.querySelector(".mcq-tag")) {
      box.insertBefore(DBMS.el("div", { class: "mcq-tag", text: "Check yourself" }), box.firstChild);
    }
    opts.forEach(function (opt, idx) {
      if (!opt.querySelector(".pick")) {
        const lbl = DBMS.el("span", { class: "pick", text: (LETTERS[idx] || "?") + "." });
        opt.insertBefore(lbl, opt.firstChild);
      }
      opt.addEventListener("click", function () {
        if (box.classList.contains("answered")) return;
        box.classList.add("answered");
        opts.forEach(function (o) { o.disabled = true; });
        opts[ans] && opts[ans].classList.add("correct");
        if (idx !== ans) opt.classList.add("wrong");
      });
    });
  }

  /* ---------- flashcard ---------- */
  function wireFlash(card) {
    if (!card.querySelector(".fc-hint")) card.appendChild(DBMS.el("div", { class: "fc-hint", text: "click to reveal" }));
    card.addEventListener("click", function () { card.classList.toggle("open"); });
  }

  function init() {
    document.querySelectorAll(".mcq[data-answer]").forEach(wireMCQ);
    document.querySelectorAll(".flashcard").forEach(wireFlash);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  DBMS.init = init;
})();
