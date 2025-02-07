import { useEffect, useRef } from "react";
import {
    Chart as ChartJS,
    CategoryScale,
    BarController,
    BarElement,
    Title,
    Tooltip,
    Legend,
} from "chart.js";
import tailwindConfig from "./../tailwind.config.js";
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

export const ReplicatorGraph = (properties: { log: SharedLog<any, any> }) => {
    const canvasRef = useRef(null);
    const chartRef = useRef<ChartJS>(null);
    useEffect(() => {
        if (!canvasRef.current) {
            return;
        }
        chartRef.current?.destroy();
        chartRef.current = new ChartJS(canvasRef.current, {
            type: "bar",
            data: { datasets: [] },
            options: {
                indexAxis: "y" as const,
                animation: {
                    duration: 0,
                },
                elements: {
                    bar: {
                        borderWidth: 3,
                        borderSkipped: false,
                    },
                },

                responsive: true,
                plugins: {
                    legend: {
                        display: false,
                    },
                    title: {
                        display: true,
                        color: tailwindConfig.theme.colors.neutral[50],
                        text: "Replication distribution",
                    },
                    subtitle: {
                        display: true,
                        color: tailwindConfig.theme.colors.neutral[200],
                        text: "Content in gaps are delegated to the closest replicator",
                        padding: {
                            bottom: 10,
                        },
                    },
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: "Content space",
                            color: tailwindConfig.theme.colors.neutral[50],
                        },
                        ticks: {
                            callback(tickValue, index, ticks) {
                                /*   if (index === 0) {
                                      return "first entry"
                                  }
                                  else if (index === 10) {
                                      return "last entry"
                                  } */
                                /*  else if (index === 5) {
                                     return "Entry #" + properties.log.log.length
                                 } */
                                return undefined;
                            },
                            /*  display: false, */
                            color: tailwindConfig.theme.colors.neutral[50],
                        },
                        grid: {
                            color: tailwindConfig.theme.colors.neutral[600],
                        },
                    },
                    y: {
                        title: {
                            display: true,
                            text: "Identity",
                            color: tailwindConfig.theme.colors.neutral[50],
                        },
                        ticks: {
                            color: tailwindConfig.theme.colors.neutral[50],
                        },
                        grid: {
                            color: tailwindConfig.theme.colors.neutral[600],
                        },
                        stacked: true,
                    },
                },
            },
        });
        chartRef.current.data;
        return () => {
            chartRef.current.destroy();
            chartRef.current = undefined;
        };
    }, [canvasRef]);

    useEffect(() => {
        if (!properties.log) {
            return;
        }

        const roleChangeListener = async (ev) => {
            let dataSets: { data: number[][] }[] = [{ data: [] }, { data: [] }];
            let labels: string[] = [];
            let myIndex = -1;
            const iterator = await properties.log.replicationIndex
                .iterate({
                    sort: [new Sort({ key: "hash" })],
                })
                .all();
            for (const [i, rect] of iterator.entries()) {
                const value = rect.value as ReplicationRangeIndexable<"u64">; // TODO why do we need this type check?

                let isMySegment =
                    value.hash ===
                    properties.log.node.identity.publicKey.hashcode();
                if (isMySegment) {
                    labels.push("you");
                    console.log(
                        "IS ME",
                        value,
                        await properties.log.replicationIndex.iterate().all(),
                        properties.log.address
                    );
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
                    set.backgroundColor = (ctx) => {
                        return ctx.dataIndex === myIndex
                            ? tailwindConfig.theme.colors.green[400] + "a0"
                            : tailwindConfig.theme.colors.primary[400] + "a0";
                    };
                    set.borderColor = (ctx) => {
                        return ctx.dataIndex === myIndex
                            ? tailwindConfig.theme.colors.green[300] + "a0"
                            : tailwindConfig.theme.colors.primary[300] + "a0";
                    };
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
                "role",
                roleChangeListener
            );
    }, [properties.log?.address]);

    return <canvas ref={canvasRef}></canvas>;
};
