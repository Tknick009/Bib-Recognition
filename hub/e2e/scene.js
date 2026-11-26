// Stands in for the iPad's camera: a canvas on which runners with bibs move
// down the picture, handed to the page as if it were the camera's stream.
(() => {
  const width = 1280;
  const height = 720;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const runners = [];
  // `frozen`: the picture stands still, as when a camera stops sending pictures without saying so.
  const scene = { runners, speed: 0.25, lineY: 0.62, width, height, frames: 0, asked: 0, frozen: false };
  window.__scene = scene;

  // Runners enter above the picture and run down it. `gap` is the time between them in ms.
  scene.send = (bibs, { gap = 900, lanes = [0.3, 0.5, 0.7], speed = scene.speed, size = 0.075, startIn = 300 } = {}) => {
    const now = performance.now();
    bibs.forEach((bib, index) => {
      const startY = -0.2;
      const t0 = now + startIn + index * gap;
      // The moment the middle of the bib is on the line, by the page's clocks.
      const crossAt = t0 + ((scene.lineY - startY) / speed) * 1000;
      runners.push({ bib: String(bib), x: lanes[index % lanes.length], t0, startY, speed, size, crossAt, crossWall: Date.now() - performance.now() + crossAt });
    });
  };

  const shirts = ['#1d4ed8', '#b91c1c', '#15803d', '#7c3aed', '#c2410c', '#0f766e'];
  function draw() {
    if (scene.frozen) {
      requestAnimationFrame(draw);
      return;
    }
    const now = performance.now();
    scene.frames += 1;
    context.fillStyle = '#6b7280';
    context.fillRect(0, 0, width, height);
    // Something for the eye and the reader to ignore.
    context.fillStyle = '#9ca3af';
    for (let stripe = 0; stripe < 6; stripe += 1) context.fillRect(0, stripe * 130 + ((now / 20) % 130) - 60, width, 6);
    runners.forEach((runner, index) => {
      const y = runner.startY + (runner.speed * (now - runner.t0)) / 1000;
      if (now < runner.t0 || y > 1.3) return;
      const digits = runner.size * height;
      const bibW = digits * 0.62 * runner.bib.length + digits * 0.9;
      const bibH = digits * 1.7;
      const cx = runner.x * width;
      const cy = y * height;
      context.fillStyle = shirts[index % shirts.length];
      context.fillRect(cx - bibW * 0.9, cy - bibH * 1.6, bibW * 1.8, bibH * 3.6);
      context.fillStyle = '#fde68a';
      context.beginPath();
      context.arc(cx, cy - bibH * 2.2, bibH * 0.55, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#ffffff';
      context.fillRect(cx - bibW / 2, cy - bibH / 2, bibW, bibH);
      context.fillStyle = '#111111';
      context.font = `bold ${digits * 1.25}px Arial, Helvetica, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(runner.bib, cx, cy + digits * 0.05);
    });
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    scene.asked += 1;
    if (window.__realCamera) return real(constraints);
    return canvas.captureStream(30);
  };
})();
