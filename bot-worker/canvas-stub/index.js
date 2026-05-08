// No-op stub for the 'canvas' package.
// prismarine-viewer uses canvas only server-side to render entity name tags.
// The real 3D scene runs in the BROWSER via Three.js — no server canvas needed.

class FakeCanvas {
  getContext() { return { drawImage(){}, fillText(){}, measureText(){ return {width:0}; }, fillRect(){}, clearRect(){}, save(){}, restore(){}, scale(){}, translate(){}, rotate(){}, beginPath(){}, closePath(){}, fill(){}, stroke(){}, arc(){}, moveTo(){}, lineTo(){}, set font(_){}, set fillStyle(_){}, set strokeStyle(_){}, set globalAlpha(_){}, set textAlign(_){}, set textBaseline(_){}, set shadowColor(_){}, set shadowBlur(_){}, createLinearGradient(){ return { addColorStop(){} }; } }; }
  toBuffer() { return Buffer.alloc(0); }
  toDataURL() { return ''; }
}
FakeCanvas.prototype.width = 0;
FakeCanvas.prototype.height = 0;

function createCanvas(w, h) { const c = new FakeCanvas(); c.width = w; c.height = h; return c; }
function createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }

class Image {
  set src(_) {}
  get naturalWidth() { return 0; }
  get naturalHeight() { return 0; }
}

export { createCanvas, FakeCanvas as Canvas, Image, createImageData };
export function loadImage() { return Promise.resolve(new Image()); }
export function registerFont() {}
export default { createCanvas, Canvas: FakeCanvas, Image, createImageData, loadImage, registerFont };
