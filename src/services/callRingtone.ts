// Warm audio on a user gesture; unsolicited incoming calls never request device permissions.
export function createCallRingtone() {
  let audio: AudioContext | null = null;
  let ringing = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const voices = new Set<OscillatorNode>();
  const pulse = () => {
    if (!ringing || !audio || audio.state !== 'running') return;
    const at = audio.currentTime;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.035, at + 0.02);
    gain.gain.setValueAtTime(0.035, at + 0.6);
    gain.gain.linearRampToValueAtTime(0, at + 0.65);
    gain.connect(audio.destination);
    let remainingVoices = 2;
    for (const frequency of [440, 480]) {
      const voice = audio.createOscillator();
      voice.frequency.value = frequency;
      voice.connect(gain);
      voices.add(voice);
      voice.onended = () => {
        voices.delete(voice);
        voice.disconnect();
        remainingVoices -= 1;
        if (!remainingVoices) gain.disconnect();
      };
      voice.start(at);
      voice.stop(at + 0.7);
    }
  };
  const warm = () => {
    if (typeof AudioContext === 'undefined') return;
    audio ??= new AudioContext();
    void audio
      .resume()
      .then(pulse)
      .catch(() => {});
  };
  window.addEventListener('pointerdown', warm);
  window.addEventListener('keydown', warm);
  return {
    setRinging(value: boolean) {
      if (value === ringing) return;
      ringing = value;
      if (timer) clearInterval(timer);
      timer = null;
      for (const voice of voices) {
        try {
          voice.stop();
        } catch {}
      }
      if (value) {
        pulse();
        timer = setInterval(pulse, 3000);
      }
    },
    dispose() {
      ringing = false;
      if (timer) clearInterval(timer);
      window.removeEventListener('pointerdown', warm);
      window.removeEventListener('keydown', warm);
      void audio?.close().catch(() => {});
    },
  };
}
