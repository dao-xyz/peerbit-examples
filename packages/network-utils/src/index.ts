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
