/**
 * ar-viewer/camera.js
 * カメラ映像の取得とフレームキャプチャ。
 * - 映像はステージ背景の <video> に流し、アバターを重ねる（簡易WebAR表現）
 * - captureFrame() は現在のフレームを JPEG の base64 で返す（Gemini 送信用）
 * 送信コストと遅延を抑えるため、長辺 768px に縮小してから送る。
 */
const MAX_FRAME_WIDTH = 768;

export class CameraManager {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.captureCanvas = document.createElement('canvas');
  }

  get isRunning() {
    return this.stream !== null;
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stop() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** 現在のフレームを { mimeType, data(base64) } で返す。未起動・未準備なら null。 */
  captureFrame() {
    if (!this.stream || this.video.readyState < 2) return null;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(1, MAX_FRAME_WIDTH / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    this.captureCanvas.width = w;
    this.captureCanvas.height = h;
    const ctx = this.captureCanvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, w, h);

    const dataUrl = this.captureCanvas.toDataURL('image/jpeg', 0.7);
    return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1] };
  }
}
