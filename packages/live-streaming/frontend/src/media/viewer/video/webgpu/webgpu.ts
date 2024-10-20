/// <reference types="@webgpu/types" />
// for some reason online inlining webgpu/types seem to actually work (instead of using types or typeRoots in tsconfig.json)

import { Renderer } from "../interface";
import fullscreenTexturedQuadWGSL from "./fullscreenTexturedQuad.wgsl?raw";
import sampleExternalTextureWGSL from "./sampleExternalTexture.frag.wgsl?raw";

// WebCodecs not enable yet --enable-webgpu-developer-features, go to chrome://flags/#enable-webgpu-developer-features to enable
export class WebGPUVideoRenderer implements Renderer {
    private canvas: HTMLCanvasElement | OffscreenCanvas;
    private context: GPUCanvasContext;
    private device: GPUDevice;
    private presentationFormat: GPUTextureFormat;
    private pipeline: GPURenderPipeline;
    private sampler: GPUSampler;

    constructor() {
        this.canvas = null;
        this.context = null;
        this.device = null;
        this.presentationFormat = null;
        this.pipeline = null;
        this.sampler = null;
    }

    public async setup(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.context = canvas.getContext("webgpu");
        const adapter = await navigator.gpu.requestAdapter();
        this.device = await adapter.requestDevice();
        this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();

        const vertexShaderModule = this.device.createShaderModule({
            code: fullscreenTexturedQuadWGSL,
        });
        const fragmentShaderModule = this.device.createShaderModule({
            code: sampleExternalTextureWGSL,
        });

        this.pipeline = this.device.createRenderPipeline({
            layout: "auto",
            vertex: {
                module: vertexShaderModule,
                entryPoint: "vert_main",
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: "main",
                targets: [
                    {
                        format: this.presentationFormat,
                    },
                ],
            },
            primitive: {
                topology: "triangle-list",
            },
        });

        this.sampler = this.device.createSampler({
            magFilter: "linear",
            minFilter: "nearest",
        });
    }

    public resize(properties: { width?: number; height?: number }) {
        const { width, height } = properties;
        const devicePixelRatio = window.devicePixelRatio || 1;
        if (!this.canvas) {
            return;
        }
        this.canvas.width = (width || this.canvas.width) * devicePixelRatio;
        this.canvas.height = (height || this.canvas.height) * devicePixelRatio;
        this.context.configure({
            device: this.device,
            format: this.presentationFormat,
            alphaMode: "premultiplied",
        });
    }

    public draw(frame: VideoFrame) {
        const uniformBindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 1,
                    resource: this.sampler,
                },
                {
                    binding: 2,
                    resource: this.device.importExternalTexture({
                        source: frame as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                    }),
                },
            ],
        });

        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [
                {
                    view: textureView,
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        };

        const passEncoder =
            commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, uniformBindGroup);
        passEncoder.draw(6, 1, 0, 0);
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
        frame.close();
    }
}
