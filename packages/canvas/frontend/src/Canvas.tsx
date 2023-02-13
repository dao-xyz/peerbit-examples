import { usePeer } from "@dao-xyz/peerbit-react";
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { getKeyFromStreamKey } from "./routes";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import createCache from "@emotion/cache";
import styled from "@emotion/styled";
import ReactDOM from "react-dom";
import { CacheProvider } from "@emotion/react";

const PreviewIframe = styled("iframe")(() => ({
    border: "none",
    height: "100%",
    width: "100%",
}));

const PreviewPortal = (props: any) => {
    const [contentRef, setContentRef] = useState<any>(null);
    const mountNode = contentRef?.contentWindow?.document?.body;
    const cache = createCache({
        key: "css",
        container: contentRef?.contentWindow?.document?.head,
        prepend: true,
    });
    return (
        <PreviewIframe ref={setContentRef}>
            {mountNode &&
                ReactDOM.createPortal(
                    <CacheProvider value={cache}>
                        {props.children}
                    </CacheProvider>,
                    mountNode
                )}
        </PreviewIframe>
    );
};

export const Canvas = () => {
    const { peer } = usePeer();
    const params = useParams();
    const [idArgs, setIdArgs] = useState<{
        identity: PublicSignKey;
        node: PublicSignKey;
    }>();
    const [isStreamer, setIsStreamer] = useState<boolean | undefined>(
        undefined
    );

    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !params.node || !params.identity) {
            return;
        }

        const node = getKeyFromStreamKey(params.node);
        setIsStreamer(peer.idKey.publicKey.equals(node));
        setIdArgs({ identity: getKeyFromStreamKey(params.identity), node });
    }, [peer?.id, params?.node]);

    return (
        <>
            <iframe></iframe>
        </>
    );
};
