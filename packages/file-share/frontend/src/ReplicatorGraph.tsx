import { useEffect, useRef, useState } from "react";
import {
    Chart as ChartJS,
    CategoryScale,
    BarController,
    BarElement,
    Title,
    Tooltip,
    Legend,
} from "chart.js";
import { ReplicationRangeIndexable, SharedLog } from "@peerbit/shared-log";
import { Sort } from "@peerbit/document";

ChartJS.register(
    BarController,
    CategoryScale,
    BarElement,
    Title,
    Tooltip,
    Legend
);

export const MAX_U64 = 18446744073709551615n;

// Helper to extract Tailwind CSS custom property values from the document
const getTailwindColors = () => {
    const style = getComputedStyle(document.documentElement);
    return {
        neutral50:
            style.getPropertyValue("--tw-neutral-50")?.trim() ||
            style.getPropertyValue("--color-neutral-50")?.trim() ||
            "#f9fafb",
        neutral200:
            style.getPropertyValue("--tw-neutral-200")?.trim() ||
            style.getPropertyValue("--color-neutral-200")?.trim() ||
            "#e5e7eb",
        neutral600:
            style.getPropertyValue("--tw-neutral-600")?.trim() ||
            style.getPropertyValue("--color-neutral-600")?.trim() ||
            "#4b5563",
        green400:
            style.getPropertyValue("--tw-green-400")?.trim() ||
            style.getPropertyValue("--color-green-400")?.trim() ||
            "#34d399",
        green300:
            style.getPropertyValue("--tw-green-300")?.trim() ||
            style.getPropertyValue("--color-green-300")?.trim() ||
            "#6ee7b7",
        primary400:
            style.getPropertyValue("--color-primary-400")?.trim() || "#000000",
        primary300:
            style.getPropertyValue("--color-primary-300")?.trim() || "#000000",
    };
};

export const ReplicatorGraph = (properties: { log: SharedLog<any, any> }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const chartRef = useRef<ChartJS | null>(null);
    const [colors, setColors] = useState(getTailwindColors());

    // Optionally update colors on window resize or theme change
    useEffect(() => {
        const updateColors = () => setColors(getTailwindColors());
        window.addEventListener("resize", updateColors);
        return () => window.removeEventListener("resize", updateColors);
    }, []);

    useEffect(() => {
        if (!canvasRef.current) return;
        chartRef.current?.destroy();
        chartRef.current = new ChartJS(canvasRef.current, {
            type: "bar",
            data: { datasets: [] },
            options: {
                indexAxis: "y",
                animation: { duration: 0 },
                elements: {
                    bar: {
                        borderWidth: 3,
                        borderSkipped: false,
                    },
                },
                responsive: true,
                plugins: {
                    legend: { display: false },
                    title: {
                        display: true,
                        color: colors.neutral50,
                        text: "Replication distribution",
                    },
                    subtitle: {
                        display: true,
                        color: colors.neutral200,
                        text: "Content in gaps are delegated to the closest replicator",
                        padding: { bottom: 10 },
                    },
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: "Content space",
                            color: colors.neutral50,
                        },
                        ticks: {
                            callback() {
                                return undefined;
                            },
                            color: colors.neutral50,
                        },
                        grid: { color: colors.neutral600 },
                    },
                    y: {
                        title: {
                            display: true,
                            text: "Identity",
                            color: colors.neutral50,
                        },
                        ticks: { color: colors.neutral50 },
                        grid: { color: colors.neutral600 },
                        stacked: true,
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
        if (!properties.log) return;

        const roleChangeListener = async (ev: any) => {
            const dataSets: {
                data: number[][];
                backgroundColor?: any;
                borderColor?: any;
            }[] = [{ data: [] }, { data: [] }];
            const labels: string[] = [];
            let myIndex = -1;
            const iterator = await properties.log.replicationIndex
                .iterate({ sort: [new Sort({ key: "hash" })] })
                .all();

            for (const [i, rect] of iterator.entries()) {
                const value = rect.value as ReplicationRangeIndexable<"u64">;
                const isMySegment =
                    value.hash ===
                    properties.log.node.identity.publicKey.hashcode();
                if (isMySegment) {
                    labels.push("you");
                    myIndex = i;
                } else {
                    labels.push(value.hash.slice(0, 5) + "...");
                }

                if (value.widthNormalized === 1) {
                    dataSets[0].data[i] = [0, 1];
                    dataSets[1].data[i] = [0, 0];
                } else {
                    dataSets[0].data[i] = [
                        Number(value.start1) / Number(MAX_U64),
                        Number(value.end1) / Number(MAX_U64),
                    ];
                    dataSets[1].data[i] = [
                        Number(value.start2) / Number(MAX_U64),
                        Number(value.end2) / Number(MAX_U64),
                    ];
                }
            }

            if (chartRef.current) {
                chartRef.current.data.labels = labels;
                chartRef.current.data.datasets = dataSets as any;
                chartRef.current.data.datasets.forEach((set) => {
                    set.backgroundColor = (ctx: any) =>
                        ctx.dataIndex === myIndex
                            ? colors.green400 + "a0"
                            : colors.primary400 + "a0";
                    set.borderColor = (ctx: any) =>
                        ctx.dataIndex === myIndex
                            ? colors.green300 + "a0"
                            : colors.primary300 + "a0";
                });
                chartRef.current.update();
            }
        };

        roleChangeListener(undefined as any);
        properties.log.events.addEventListener(
            "replication:change",
            roleChangeListener
        );
        return () =>
            properties.log.events.removeEventListener(
                "replication:change",
                roleChangeListener
            );
    }, [properties.log?.address, colors]);

    return <canvas ref={canvasRef}></canvas>;
};
