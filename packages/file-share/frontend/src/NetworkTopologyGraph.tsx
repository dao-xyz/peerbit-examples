import { Chart as ChartJS } from "chart.js/auto";

import tailwindConfig from "./../tailwind.config.js";
import { Peerbit } from "peerbit";
import { useEffect, useReducer, useRef, useState } from "react";
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

// register controller in chart.js and ensure the defaults are set
ChartJS.register(
    ForceDirectedGraphController,
    TreeChart,
    TreeController,
    DendrogramController,
    EdgeLine
);

const styles = {
    pointBorderColor: tailwindConfig.theme.colors.neutral[50],
    edgeLineBorderColor: tailwindConfig.theme.colors.neutral[50],
};
export const NetworkTopologyGraph = () => {
    const { peer } = usePeer();
    const canvasRef = useRef(null);
    const chartRef = useRef<ChartJS>(null);
    useEffect(() => {
        if (!canvasRef.current) {
            return;
        }
        chartRef.current?.destroy();
        chartRef.current = new ChartJS(canvasRef.current, {
            type: "forceDirectedGraph",

            data: { datasets: [] },
            options: {
                responsive: true,
                animation: {
                    duration: 0,
                },
                plugins: {
                    legend: {
                        display: false,
                    },
                    title: {
                        display: true,
                        color: tailwindConfig.theme.colors.neutral[50],
                        text: "Route map",
                    },
                    subtitle: {
                        display: true,
                        color: tailwindConfig.theme.colors.neutral[200],
                        text: "A dashed line represents a path with unknown hops",
                        padding: {
                            bottom: 20,
                        },
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
                        min: -1.5, // make sure long labels dont overflow
                        max: 1.5, // make sure long labels dont overflow
                    },
                },
                /*   tree: {
                      orientation: 'radial',
                      mode: 'tree'
                  } */
            },
        });
        chartRef.current.data;
        return () => {
            chartRef.current.destroy();
            chartRef.current = undefined;
        };
    }, [canvasRef]);

    useEffect(() => {
        if (!peer) {
            return;
        }
        let client = peer;
        if (peer instanceof PeerbitProxyHost) {
            client = peer.hostClient;
        }
        if (client instanceof Peerbit === false) {
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
            let data = labels.map((x) => {
                return {
                    label: x.length > 10 ? x.substring(0, 10) + "..." : x,
                };
            });
            chartRef.current.data.datasets = [
                {
                    ...{
                        ...styles,
                        edgeLineBorderDash: (ctx) => dashes[ctx.index],
                        pointBackgroundColor: (ctx) =>
                            ctx.index === 0
                                ? tailwindConfig.theme.colors.green[500]
                                : tailwindConfig.theme.colors.neutral[500],
                    },
                    pointRadius: 10,
                    data,
                    edges,
                },
            ];
            chartRef.current.update();
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
    }, [peer?.identity.publicKey.hashcode()]);

    return <canvas ref={canvasRef}></canvas>;

    /* return datasets.datasets.length > 0 ? <Chart type="forceDirectedGraph" options={{
        responsive: true,
        animation: {
            duration: 0
        },
        plugins: {
            legend: {
                display: false
            },
            title: {
                display: true,
                color: tailwindConfig.theme.colors.neutral[50],
                text: 'Route map'
            },
            datalabels: {
                color: 'white',
                backgroundColor: "black",
                borderRadius: 9999,
                borderColor: "white",
                borderWidth: 1,

            },
        },

        scales: {

            x: {
                min: -1.5,  // make sure long labels dont overflow
                max: 1.5 // make sure long labels dont overflow
            }
        }
    }} data={datasets} /> : <></> */
};
