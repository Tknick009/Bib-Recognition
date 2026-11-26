// The iPad's camera: starting it, choosing between its lenses, zooming, and
// saying when each new picture was taken.

/** Why the camera could not be started, in words for the person holding the iPad. */
export class CameraProblem extends Error {
  /** @param {string} kind 'denied' | 'missing' | 'busy' | 'unsupported' | 'other' */
  constructor(kind, message) {
    super(message);
    this.name = 'CameraProblem';
    this.kind = kind;
  }
}

function describe(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraProblem('denied',
        'This site was not allowed to use the camera. Tap the icon at the left of the address bar, choose Website Settings, set Camera to Allow, ' +
        'then tap “Start the camera”. (Or: Settings → Apps → Safari → Camera → Allow.)');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraProblem('missing', 'No camera was found on this device.');
    case 'NotReadableError':
    case 'AbortError':
      return new CameraProblem('busy', 'The camera could not be started. Another app may be using it: close that app, then tap “Start the camera”.');
    default:
      return new CameraProblem('other', `The camera could not be started (${error?.message ?? error}).`);
  }
}

// From a browser's report of a picture to the picture being on show, in milliseconds.
const reportedToShown = 35;

export class Camera {
  #video;
  #stream = null;
  #track = null;
  #starting = 0;

  /**
   * How long before a picture is shown the camera took it, in milliseconds.
   * Where the browser reports when a picture reached it from the camera,
   * that moment is used, less the part of this delay that lies before it.
   */
  delay = 60;
  /** Called when the camera stops by itself (the page was put away, another app took it). */
  onEnded = () => {};
  /**
   * Called with true when the camera stops sending pictures without ending
   * (paused in the browser, taken by another app, the iPad too hot), and
   * with false when it sends them again.
   */
  onMuted = () => {};

  /** @param {HTMLVideoElement} video where the camera's picture is shown */
  constructor(video) {
    this.#video = video;
  }

  get running() {
    return this.#track !== null && this.#track.readyState === 'live';
  }

  /** True while the camera is on but sending no pictures. */
  get muted() {
    return this.#track !== null && this.#track.muted === true;
  }

  /** The picture's size in pixels; 0 until the first picture has arrived. */
  get width() {
    return this.#video.videoWidth;
  }

  get height() {
    return this.#video.videoHeight;
  }

  /** The name of the lens in use, and its identifier. */
  get current() {
    if (!this.#track) return null;
    return { id: this.#track.getSettings?.().deviceId ?? null, label: this.#track.label };
  }

  /**
   * Starts the camera: the lens asked for if there is one, otherwise the
   * one on the back.
   */
  async start(deviceID = null) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraProblem('unsupported', window.isSecureContext
        ? 'This browser cannot use the camera from a web page.'
        : 'The camera only works when the page is opened with an address that begins with https://.');
    }
    const attempt = ++this.#starting;
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    const choices = [];
    if (deviceID) choices.push({ ...size, deviceId: { exact: deviceID } });
    choices.push({ ...size, facingMode: { ideal: 'environment' } });
    choices.push(true);

    let stream = null;
    let failure = null;
    for (const video of choices) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
        break;
      } catch (error) {
        failure = error;
        // Asking again in another way does not change a "no".
        if (error.name === 'NotAllowedError' || error.name === 'SecurityError') break;
      }
    }
    if (!stream) throw describe(failure);
    if (attempt !== this.#starting) {
      // Started again, or stopped, while the browser was asking for permission.
      for (const track of stream.getTracks()) track.stop();
      throw new CameraProblem('other', 'The camera was started again before it was ready.');
    }

    const [track] = stream.getVideoTracks();
    this.#stream = stream;
    this.#track = track;
    track.addEventListener('ended', () => {
      if (track === this.#track) this.onEnded();
    });
    track.addEventListener('mute', () => {
      if (track === this.#track) this.onMuted(true);
    });
    track.addEventListener('unmute', () => {
      if (track === this.#track) this.onMuted(false);
    });

    const video = this.#video;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // The video element starts by itself (it is muted and marked to).
    }
    // Wait for the first picture, so that its size is known.
    for (let waited = 0; video.videoWidth === 0 && waited < 5000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (attempt !== this.#starting) throw new CameraProblem('other', 'The camera was started again before it was ready.');
    }
    if (video.videoWidth === 0) {
      this.stop();
      throw new CameraProblem('busy', 'The camera was started but sent no picture. Tap “Start the camera” to try again.');
    }
    return { width: video.videoWidth, height: video.videoHeight, label: track.label };
  }

  stop() {
    this.#starting += 1;
    const stream = this.#stream;
    this.#stream = null;
    this.#track = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (this.#video.srcObject) this.#video.srcObject = null;
  }

  /** The video has been paused by the browser (after the page was put away, say): set it going again. */
  async resume() {
    if (!this.running) return false;
    if (this.#video.paused) {
      try {
        await this.#video.play();
      } catch {
        return false;
      }
    }
    return true;
  }

  /** The lenses there are to choose from: [{ id, label }]. Names are only known once the camera has been allowed. */
  async lenses() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === 'videoinput' && device.deviceId !== '')
        .map((device, index) => ({ id: device.deviceId, label: device.label || `Camera ${index + 1}` }));
    } catch {
      return [];
    }
  }

  /** How far the lens in use can zoom: { min, max, step, now }; null if it cannot. */
  get zoomRange() {
    const range = this.#track?.getCapabilities?.().zoom;
    if (!range || !(range.max > range.min)) return null;
    return { min: range.min, max: range.max, step: range.step || 0.1, now: this.#track.getSettings?.().zoom ?? range.min };
  }

  async setZoom(value) {
    if (!this.#track || !this.zoomRange) return;
    try {
      await this.#track.applyConstraints({ advanced: [{ zoom: value }] });
    } catch {
      // The lens would not: it stays as it is.
    }
  }

  /**
   * Calls `use(time)` when the next new picture from the camera is on show,
   * with the moment it was taken, on the page's own clock in milliseconds.
   * Whatever `use` draws from the video at once is that picture.
   *
   * @returns {() => void} call it to give up waiting
   */
  whenFrame(use) {
    const video = this.#video;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const handle = video.requestVideoFrameCallback((now, metadata) => {
        const handed = metadata?.captureTime;
        // Some browsers say when the picture reached them from the camera.
        // That is not yet the moment the lens saw it, which lies a little
        // earlier still: of the whole delay from lens to screen, about 35 ms
        // are taken to lie after that report. Where there is no report, the
        // whole delay is taken off the moment the picture was shown.
        if (typeof handed === 'number' && handed <= now + 5 && now - handed < 1000) use(handed - Math.max(0, this.delay - reportedToShown));
        else use((metadata?.presentationTime ?? now) - this.delay);
      });
      return () => video.cancelVideoFrameCallback(handle);
    }
    const handle = requestAnimationFrame((now) => use(now - this.delay));
    return () => cancelAnimationFrame(handle);
  }
}
