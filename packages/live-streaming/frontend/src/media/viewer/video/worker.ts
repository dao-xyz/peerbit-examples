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
        const gl = (this.#ctx = canvas.getContext("webgl2", {
            alpha: false,
            antialias: false,
            desynchronizing: true,
            powerPreference: "high-performance",
        }) as WebGL2RenderingContext);

        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        const halfFloat = gl.getExtension("OES_texture_half_float");
        const t2 = gl.getExtension("OES_texture_half_float_linear");

        console.log("HF?", halfFloat, t2);
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
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // mipmap downscaling?
        // gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        // gl.generateMipmap(gl.TEXTURE_2D);

        // anisotropic?
        /*  const ext =
             gl.getExtension("EXT_texture_filter_anisotropic") ||
             gl.getExtension("MOZ_EXT_texture_filter_anisotropic") ||
             gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
         if (ext) {
             const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
             gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, max);
         } */
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
            gl.RGB,
            gl.RGB,
            gl.UNSIGNED_BYTE,
            frame
        );
        frame.close();

        // Configure and clear the drawing area.
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); // gl.canvas.width, gl.canvas.height);
        gl.clearColor(1.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // Draw the frame.
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
        gl.generateMipmap(gl.TEXTURE_2D);
    }
}

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

/* 
export class WebGPURenderer implements Renderer {
    #device: GPUDevice = null;
    #canvas: OffscreenCanvas | HTMLCanvasElement;
    #texture: GPUTexture = null;
    #textureView: GPUTextureView = null;
    #textureBindGroup: GPUBindGroup = null;
    #textureBindGroupLayout: GPUBindGroupLayout = null;
    #textureSampler: GPUSampler = null;

    static vertexShaderSource = `
      struct VertexOutput {
        [[builtin(position)]] Position : vec4<f32>;
        [[location(0)]] UV : vec2<f32>;
      };
  
      [[stage(vertex)]]
      fn main([[location(0)]] position: vec4<f32>) -> VertexOutput {
        var output: VertexOutput;
        output.Position = position;
        output.UV = (position.xy + vec2<f32>(1.0)) / vec2<f32>(2.0);
        return output;
      }
    `;

    static fragmentShaderSource = `
      [[group(0), binding(0)]] var textureSampler: sampler;
      [[group(0), binding(1)]] var texture: texture_2d<f32>;
  
      [[stage(fragment)]]
      fn main([[location(0)]] uv: vec2<f32>) -> [[location(0)]] vec4<f32> {
        return textureSample(texture, textureSampler, uv);
      }
    `;

    pendingFrame: VideoFrame | undefined = undefined;

    async setup(canvas: OffscreenCanvas | HTMLCanvasElement) {
        this.#canvas = canvas;
        const adapter = await navigator.gpu.requestAdapter();
        this.#device = await adapter.requestDevice();

        const vertexShaderModule = this.#device.createShaderModule({
            code: WebGPURenderer.vertexShaderSource,
        });
        const fragmentShaderModule = this.#device.createShaderModule({
            code: WebGPURenderer.fragmentShaderSource,
        });

        const pipeline = this.#device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: vertexShaderModule,
                entryPoint: "main",
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: "main",
                targets: [
                    {
                        format: "rgba8unorm",
                    },
                ],
            },
            primitive: {
                topology: "triangle-strip",
                stripIndexFormat: undefined,
                cullMode: "none",
            },
        });

        const verticesBuffer = this.#device.createBuffer({
            size: 4 * 4 * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
        const vertexArray = new Float32Array(verticesBuffer.getMappedRange());
        vertexArray.set([-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0]);
        verticesBuffer.unmap();

        this.#textureSampler = this.#device.createSampler({
            magFilter: "linear",
            minFilter: "nearest",
        });

        this.#textureBindGroupLayout = this.#device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: {
                        type: "filtering",
                    },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {
                        sampleType: "float",
                    },
                },
            ],
        });

        this.#texture = this.#device.createTexture({
            size: {
                width: canvas.width,
                height: canvas.height,
                depthOrArrayLayers: 1,
            },
            format: "rgba8unorm",
            usage: GPUTextureUsage.COPY_DST,
        });

        this.#textureView = this.#texture.createView();

        this.#textureBindGroup = this.#device.createBindGroup({
            layout: this.#textureBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this.#textureSampler,
                },
                {
                    binding: 1,
                    resource: this.#textureView,
                },
            ],
        });

        canvas.addEventListener("resize", () => {
            this.resize({ width: canvas.width, height: canvas.height });
        });

        this.resize({ width: canvas.width, height: canvas.height });
    }

    public resize(data: { width?: number; height?: number }) {
        if (data.width != null) this.#canvas.width = data.width;
        if (data.height != null) this.#canvas.height = data.height;

        if (this.#texture) {
            this.#texture.destroy();
        }

        this.#texture = this.#device.createTexture({
            size: {
                width: this.#canvas.width,
                height: this.#canvas.height,
                depthOrArrayLayers: 1
            },
            format: "rgba8unorm",
            usage: GPUTextureUsage.COPY_DST,
        });

        this.#textureView = this.#texture.createView();
        this.#textureBindGroup = this.#device.createBindGroup({
            layout: this.#textureBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this.#textureSampler,
                },
                {
                    binding: 1,
                    resource: this.#textureView,
                },
            ],
        });
    }

    public async draw(frame: VideoFrame) {
        if (this.pendingFrame) {
            // Close the current pending frame before replacing it.
            this.pendingFrame.close();
        }
        // Set or replace the pending frame.
        this.pendingFrame = frame;

        if (this.#texture) {
            // Import the frame as an external texture
            await this.#device.importExternalTexture({
                source: frame
            });
        }
    }

    private _renderAnimationFrame() {
        this._draw(this.pendingFrame);
        this.pendingFrame = null;
    }

    private _draw(frame: VideoFrame) {
        const commandEncoder = this.#device.createCommandEncoder();
        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [
                {
                    view: this.#canvas.getCurrentTexture().createView(),
                    loadValue: { r: 1.0, g: 0.0, b: 0.0, a: 1.0 },
                    storeOp: "store",
                },
            ],
        };

        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

        passEncoder.setPipeline(pipeline);
        passEncoder.setVertexBuffer(0, verticesBuffer);
        passEncoder.setBindGroup(0, this.#textureBindGroup);
        passEncoder.draw(4, 1, 0, 0);

        passEncoder.endPass();

        this.#device.queue.submit([commandEncoder.finish()]);
    }
} */
