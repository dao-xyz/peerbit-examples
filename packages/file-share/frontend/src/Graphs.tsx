import * as Tabs from "@radix-ui/react-tabs";
import { NetworkTopologyGraph } from "./NetworkTopologyGraph";
import { ReplicatorGraph } from "./ReplicatorGraph";
import { SharedLog } from "@peerbit/shared-log";

export const GraphExplorer = (properties: { log: SharedLog<any> }) => {
    return (
        <Tabs.Root defaultValue="replication">
            <Tabs.List className="flex flex-row gap-2">
                <Tabs.Trigger
                    className="data-[state=active]:underline underline-offset-4"
                    value="replication"
                >
                    Replication
                </Tabs.Trigger>
                <Tabs.Trigger
                    className="data-[state=active]:underline underline-offset-4"
                    value="topology"
                >
                    Topology
                </Tabs.Trigger>
            </Tabs.List>

            <div className="p-4">
                <Tabs.Content value="replication">
                    <ReplicatorGraph log={properties.log} />
                </Tabs.Content>
                <Tabs.Content value="topology">
                    <NetworkTopologyGraph />
                </Tabs.Content>
            </div>
        </Tabs.Root>
    );
};
