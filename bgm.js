// Original ambient score, synthesized locally without audio downloads.
(() => {
  const buttons = [...document.querySelectorAll("[data-bgm]")];
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  let context,
    master,
    timer,
    nextBar = 0,
    bar = 0;
  let playing = false,
    busy = false;
  const chords = [
    [45, 52, 59, 60],
    [41, 48, 55, 57],
    [38, 45, 53, 57],
    [40, 47, 56, 62],
  ];
  const melody = [76, 71, 72, 68, 69, 76, 74, 71];
  const frequency = (note) => 440 * 2 ** ((note - 69) / 12);
  function update() {
    buttons.forEach((button) => {
      button.disabled = busy || !AudioContextClass;
      button.setAttribute("aria-pressed", String(playing));
      button.textContent = !AudioContextClass
        ? "♪ BGM 지원 안 됨"
        : playing
          ? "♪ BGM 끄기"
          : "♪ BGM 켜기";
      button.setAttribute(
        "aria-label",
        playing ? "배경 음악 끄기" : "배경 음악 켜기",
      );
    });
  }
  function voice(note, start, duration, bell = false, detune = 0) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = bell ? "sine" : "triangle";
    oscillator.frequency.value = frequency(note);
    oscillator.detune.value = detune;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(
      bell ? 0.045 : 0.028,
      start + (bell ? 0.03 : 1.8),
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.1);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
  }
  function schedule() {
    if (!playing || context.state !== "running") return;
    if (nextBar > context.currentTime + 0.5) return;
    const start = Math.max(nextBar, context.currentTime + 0.04);
    chords[bar % chords.length].forEach((note, i) =>
      voice(note, start, 9, false, i % 2 ? 3 : -3),
    );
    voice(melody[bar % melody.length], start + 2.5, 3.5, true);
    voice(melody[(bar + 3) % melody.length] - 12, start + 6, 3, true);
    nextBar = start + 8;
    bar++;
  }
  function initialize() {
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = 0;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 950;
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.42;
    const feedback = context.createGain();
    feedback.gain.value = 0.24;
    const wet = context.createGain();
    wet.gain.value = 0.3;
    master.connect(filter);
    filter.connect(context.destination);
    filter.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(context.destination);
    nextBar = context.currentTime;
    bar = 0;
  }
  async function toggle() {
    if (busy || !AudioContextClass) return;
    busy = true;
    update();
    try {
      if (playing) {
        playing = false;
        clearInterval(timer);
        master.gain.cancelScheduledValues(context.currentTime);
        master.gain.setValueAtTime(master.gain.value, context.currentTime);
        master.gain.linearRampToValueAtTime(0, context.currentTime + 0.15);
        await new Promise((resolve) => setTimeout(resolve, 180));
        await context.suspend();
      } else {
        if (!context || context.state === "closed") initialize();
        await context.resume();
        playing = true;
        master.gain.cancelScheduledValues(context.currentTime);
        master.gain.setValueAtTime(0, context.currentTime);
        master.gain.linearRampToValueAtTime(0.35, context.currentTime + 0.5);
        schedule();
        timer = setInterval(schedule, 500);
      }
      const status = document.getElementById("bgm-status");
      if (status) status.textContent = "";
    } catch {
      playing = false;
      clearInterval(timer);
      if (context && context.state !== "closed")
        await context.close().catch(() => {});
      const status = document.getElementById("bgm-status");
      if (status)
        status.textContent =
          "음악을 재생하지 못했어요. 다시 켜기를 눌러주세요.";
    } finally {
      busy = false;
      update();
    }
  }
  buttons.forEach((button) => button.addEventListener("click", toggle));
  window.addEventListener("pagehide", () => {
    playing = false;
    clearInterval(timer);
    if (context && context.state !== "closed") context.close().catch(() => {});
    update();
  });
  update();
})();
