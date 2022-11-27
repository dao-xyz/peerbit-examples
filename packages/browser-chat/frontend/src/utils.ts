import axios from "axios";
export const resolveSwarmAddress = async (url: string) => {
    if (url.startsWith("http") == false) {
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
    return (
        "/dns4/" +
        domain +
        "/tcp/4002/wss/p2p/" +
        (await axios.get(url + ":9002/ipfs/id")).data
    );
};
