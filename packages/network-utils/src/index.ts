import axios from "axios";

export const resolveSwarmAddress = async (url: string, timeout = 5000) => {
    if (url.startsWith("/")) {
        return url; // Possible already an swarm address
    }
    if (url.startsWith("http") === false) {
        url = "https://" + url;
    }
    if (url.endsWith("/")) {
        url = url.substring(0, url.length - 1);
    }
    let domain = url;
    if (domain.startsWith("http://")) {
        domain = domain.substring("http://".length);
    }
    if (domain.startsWith("https://")) {
        domain = domain.substring("https://".length);
    }
    if (domain.startsWith("localhost")) {
        return (
            "/ip4/127.0.0.1/tcp/8002/ws/p2p/" +
            (await axios.get(url + ":8082/peer/id", { timeout })).data
        );
    }
    return (
        "/dns4/" +
        domain +
        "/tcp/4003/wss/p2p/" +
        (await axios.get(url + ":9002/peer/id", { timeout })).data
    );
};

export type NetworkType = "local" | "remote";
export const resolveBootstrapAddresses = async (network: NetworkType) => {
    // Bootstrap addresses for network
    try {
        let bootstrapAddresses: string[] = [];
        if (network === "local") {
            bootstrapAddresses = [
                await resolveSwarmAddress("http://localhost"),
            ];
        } else {
            const swarmAddressees = (
                await axios.get(
                    "https://raw.githubusercontent.com/dao-xyz/peerbit-bootstrap/master/bootstrap.env"
                )
            ).data
                .split(/\r?\n/)
                .filter((x) => x.length > 0);
            bootstrapAddresses = await Promise.all(
                swarmAddressees.map((s) => resolveSwarmAddress(s))
            );
        }
        return bootstrapAddresses;
    } catch (error: any) {
        console.error(
            "Failed to resolve relay node. Please come back later or start the demo locally: " +
                error?.message
        );
    }
};
