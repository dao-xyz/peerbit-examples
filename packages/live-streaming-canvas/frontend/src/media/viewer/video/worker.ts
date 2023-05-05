import { Renderer } from "./interface";

/* const hasWebGL = (canvas: OffscreenCanvas) => !!(canvas.getContext("webgl") || canvas.getContext("webgl2"))
 */
class RenderWorker {
    #canvas: OffscreenCanvas | HTMLCanvasElement = null;
    #renderer: Renderer;
    constructor() {
        this.#renderer = new WebGLRenderer();
        // Listen for the start request.
        self.addEventListener("message", (message) => {
            const data = message.data as
                | CanvasMessage
                | FrameMessage
                | ResizeMessage;
            if (data.type === "canvas") {
                this.setup(data.canvas);
            } else if (data.type === "frame") {
                this.#renderer.draw(data.frame);
            } else {
                this.#renderer.resize(data);
            }
        });
    }

    setup(canvas: OffscreenCanvas) {
        this.#canvas = canvas;
        this.#renderer.setup(canvas);
    }

    get canvas() {
        return this.#canvas;
    }

    draw(frame: VideoFrame) {
        this.#renderer.draw(frame);
    }
}

// "webgl" or "webgl2"
export class WebGLRenderer implements Renderer {
    #ctx: WebGL2RenderingContext | WebGLRenderingContext = null;
    #canvas: OffscreenCanvas | HTMLCanvasElement;
    static vertexShaderSource = `
      attribute vec2 xy;
  
      varying highp vec2 uv;
  
      void main(void) {
        gl_Position = vec4(xy, 0.0, 1.0);
        // Map vertex coordinates (-1 to +1) to UV coordinates (0 to 1).
        // UV coordinates are Y-flipped relative to vertex coordinates.
        uv = vec2((1.0 + xy.x) / 2.0, (1.0 - xy.y) / 2.0);
      }
    `;

    static fragmentShaderSource = `
      varying highp vec2 uv;
  
      uniform sampler2D texture;
  
      void main(void) {
        gl_FragColor = texture2D(texture, uv);
      }
    `;

    pendingFrame: VideoFrame | undefined = undefined;

    setup(canvas: OffscreenCanvas | HTMLCanvasElement) {
        this.#canvas = canvas;
        const gl = (this.#ctx =
            (canvas.getContext("webgl2") as WebGL2RenderingContext) ||
            (canvas.getContext("webgl") as WebGLRenderingContext));
        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, WebGLRenderer.vertexShaderSource);
        gl.compileShader(vertexShader);
        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
            throw gl.getShaderInfoLog(vertexShader);
        }

        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, WebGLRenderer.fragmentShaderSource);
        gl.compileShader(fragmentShader);
        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
            throw gl.getShaderInfoLog(fragmentShader);
        }

        const shaderProgram = gl.createProgram();
        gl.attachShader(shaderProgram, vertexShader);
        gl.attachShader(shaderProgram, fragmentShader);
        gl.linkProgram(shaderProgram);
        if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
            throw gl.getProgramInfoLog(shaderProgram);
        }
        gl.useProgram(shaderProgram);

        // Vertex coordinates, clockwise from bottom-left.
        const vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1.0, -1.0, -1.0, +1.0, +1.0, +1.0, +1.0, -1.0]),
            gl.STATIC_DRAW
        );

        const xyLocation = gl.getAttribLocation(shaderProgram, "xy");
        gl.vertexAttribPointer(xyLocation, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(xyLocation);

        // Create one texture to upload frames to.
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    public resize(data: { width?: number; height?: number }) {
        if (data.width != null) this.#canvas.width = data.width;
        if (data.height != null) this.#canvas.height = data.height;
    }

    public draw(frame: VideoFrame) {
        if (!this.pendingFrame) {
            // Schedule rendering in the next animation frame.
            requestAnimationFrame(this._renderAnimationFrame.bind(this));
        } else {
            // Close the current pending frame before replacing it.
            this.pendingFrame.close();
        }
        // Set or replace the pending frame.
        this.pendingFrame = frame;
    }

    private _renderAnimationFrame() {
        this._draw(this.pendingFrame);
        this.pendingFrame = null;
    }

    private _draw(frame: VideoFrame) {
        /*   this.#canvas.width = frame.displayWidth;
          this.#canvas.height = frame.displayHeight;
   */
        const gl = this.#ctx;

        // Upload the frame.
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            frame
        );
        frame.close();

        // Configure and clear the drawing area.
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(1.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // Draw the frame.
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }
}

// "2D" context
/* class CanvasRenderer implements Renderer {
    #canvas: OffscreenCanvas
    #ctx: OffscreenCanvasRenderingContext2D;
    draw(frame: VideoFrame) {
         this.#canvas.width = frame.displayWidth;
          this.#canvas.height = frame.displayHeight; 

        this.#ctx.drawImage(frame,
            0,
            0,
        );


        frame.close();
    }
    setup(canvas: OffscreenCanvas) {
        this.#canvas = canvas;
        this.#ctx = canvas.getContext("2d")
    }
}
 */

export interface FrameMessage {
    type: "frame";
    frame: VideoFrame;
}

export interface CanvasMessage {
    type: "canvas";
    canvas: OffscreenCanvas;
}

export interface ResizeMessage {
    type: "size";
    width?: number;
    height?: number;
}

new RenderWorker();
