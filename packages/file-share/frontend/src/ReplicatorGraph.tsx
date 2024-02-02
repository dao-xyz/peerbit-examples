import React, { useEffect, useRef, useState } from "react";
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
import { SharedLog, Replicator } from "@peerbit/shared-log";

ChartJS.register(
    BarController,
    CategoryScale,
    BarElement,
    Title,
    Tooltip,
    Legend
);

export const ReplicatorGraph = (properties: { log: SharedLog<any> }) => {
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

        const roleChangeListener = (ev) => {
            let dataSets: { data: number[][] }[] = [{ data: [] }, { data: [] }];
            let labels: string[] = [];
            let myIndex = -1;
            for (const [i, rect] of properties.log
                .getReplicatorsSorted()
                .toArray()
                .entries()) {
                let replicator: Replicator = rect.role;
                if (
                    rect.publicKey.equals(
                        properties.log.node.identity.publicKey
                    )
                ) {
                    labels.push("you");
                    myIndex = i;
                } else {
                    labels.push(rect.publicKey.hashcode().slice(0, 5) + "...");
                }

                if (replicator.factor === 1) {
                    dataSets[0].data[i] = [0, 1];
                    dataSets[1].data[i] = [0, 0];
                } else {
                    let start1 = replicator.offset;
                    let end = start1 + replicator.factor;
                    let end1 = Math.min(1, end);
                    let end2 = end > 1 ? end - 1 : 0;
                    let start2 = 0;
                    dataSets[0].data[i] = [start1, end1];
                    dataSets[1].data[i] = [start2, end2];
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
        properties.log.events.addEventListener("role", roleChangeListener);
        return () =>
            properties.log.events.removeEventListener(
                "role",
                roleChangeListener
            );
    }, [properties.log?.address]);

    return <canvas ref={canvasRef}></canvas>;
};
