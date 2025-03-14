import { Chart as ChartJS } from "chart.js/auto";
import { Peerbit } from "peerbit";
import { useEffect, useRef, useState } from "react";
import { usePeer } from "@peerbit/react";
import { PeerbitProxyHost } from "@peerbit/proxy";
import ChartDataLabels from "chartjs-plugin-datalabels";
import {
    TreeChart,
    TreeController,
    ForceDirectedGraphController,
    DendrogramController,
    EdgeLine,
} from "chartjs-chart-graph";

// Register controllers and plugins
ChartJS.register(
    ForceDirectedGraphController,
    TreeChart,
    TreeController,
    DendrogramController,
    EdgeLine,
    ChartDataLabels
);

// Helper to read CSS custom properties defined in your index.css
const getTailwindColors = () => {
    const style = getComputedStyle(document.documentElement);
    return {
        neutral50:
            style.getPropertyValue("--tw-neutral-50")?.trim() || "#f9fafb", // fallback if not defined
        neutral200:
            style.getPropertyValue("--tw-neutral-200")?.trim() || "#e5e7eb",
        neutral500:
            style.getPropertyValue("--tw-neutral-500")?.trim() || "#6b7280",
        green500: style.getPropertyValue("--tw-green-500")?.trim() || "#22c55e",
        // Assuming you have defined these custom properties in your CSS
        primary400:
            style.getPropertyValue("--color-primary-400")?.trim() || "#cbd5e1", // adjust fallback as needed
    };
};

export const NetworkTopologyGraph = () => {
    const { peer } = usePeer();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const chartRef = useRef<ChartJS | null>(null);
    const [colors, setColors] = useState(getTailwindColors());

    // Update colors on window resize (or you can hook into theme toggles)
    useEffect(() => {
        const updateColors = () => setColors(getTailwindColors());
        window.addEventListener("resize", updateColors);
        return () => window.removeEventListener("resize", updateColors);
    }, []);

    // Remove tailwind config; instead, use dynamic colors in our styles object.
    const styles = {
        pointBorderColor: colors.neutral50,
        edgeLineBorderColor: colors.neutral50,
    };

    useEffect(() => {
        if (!canvasRef.current) return;
        chartRef.current?.destroy();
        chartRef.current = new ChartJS(canvasRef.current, {
            type: "forceDirectedGraph",
            data: { datasets: [] },
            options: {
                responsive: true,
                animation: { duration: 0 },
                plugins: {
                    legend: { display: false },
                    title: {
                        display: true,
                        color: colors.neutral50,
                        text: "Route map",
                    },
                    subtitle: {
                        display: true,
                        color: colors.neutral200,
                        text: "A dashed line represents a path with unknown hops",
                        padding: { bottom: 20 },
                    },
                    datalabels: {
                        color: "white",
                        backgroundColor: "black",
                        borderRadius: 9999,
                        borderColor: "white",
                        borderWidth: 1,
                    },
                },
                scales: {
                    x: {
                        min: -1.5, // Ensure long labels don't overflow
                        max: 1.5,
                    },
                },
            },
        });
        return () => {
            chartRef.current?.destroy();
            chartRef.current = null;
        };
    }, [canvasRef, colors]);

    useEffect(() => {
        if (!peer) return;
        let client = peer;
        if (peer instanceof PeerbitProxyHost) {
            client = peer.hostClient;
        }
        if (!(client instanceof Peerbit)) {
            throw new Error(
                "Network Topology graph can only be used with a non-proxy client"
            );
        }
        let updateGraph = () => {
            let nodeIndexMap: Map<string, number> = new Map();
            let labels: string[] = [];
            const getSetIndex = (key: string): number => {
                let index = nodeIndexMap.get(key);
                if (index == null) {
                    labels.push(key);
                    index = nodeIndexMap.size;
                    nodeIndexMap.set(key, index);
                }
                return index;
            };
            let edges: { source: number; target: number; options: any }[] = [];
            let dashes: ([number, number] | undefined)[] = [];
            getSetIndex("you");
            const routesFromMe = (
                client as Peerbit
            ).services.pubsub.routes.routes.get(
                client.identity.publicKey.hashcode()
            );
            if (routesFromMe) {
                for (const [target, routes] of routesFromMe) {
                    for (const neighbour of routes.list) {
                        edges.push({
                            source: getSetIndex("you"),
                            target: getSetIndex(neighbour.hash),
                            options: {},
                        });
                        dashes.push(undefined);
                        if (neighbour.hash !== target) {
                            edges.push({
                                source: getSetIndex(neighbour.hash),
                                target: getSetIndex(target),
                                options: {},
                            });
                            dashes.push([5, 5]);
                        }
                    }
                }
            }
            let data = labels.map((x) => ({
                label: x.length > 10 ? x.substring(0, 10) + "..." : x,
            }));
            chartRef.current!.data.datasets = [
                {
                    ...styles,
                    edgeLineBorderDash: (ctx: any) => dashes[ctx.index], /// TODO does this property exist?
                    pointBackgroundColor: (ctx: any) =>
                        ctx.index === 0 ? colors.green500 : colors.neutral500,
                    pointRadius: 10,
                    data,
                    edges,
                } as any,
            ];
            chartRef.current!.update();
        };
        client.services.pubsub.addEventListener("peer:reachable", updateGraph);
        client.services.pubsub.addEventListener(
            "peer:unreachable",
            updateGraph
        );
        client.services.pubsub.addEventListener("peer:session", updateGraph);
        updateGraph();
        return () => {
            client.services.pubsub.removeEventListener(
                "peer:reachable",
                updateGraph
            );
            client.services.pubsub.removeEventListener(
                "peer:unreachable",
                updateGraph
            );
            client.services.pubsub.removeEventListener(
                "peer:session",
                updateGraph
            );
        };
    }, [peer?.identity.publicKey.hashcode(), colors]);

    return <canvas ref={canvasRef}></canvas>;
};
