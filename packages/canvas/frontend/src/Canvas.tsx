import { useState, useEffect } from "react";
import createCache from "@emotion/cache";
import styled from "@emotion/styled";
import ReactDOM from "react-dom";
import { CacheProvider } from "@emotion/react";

const logChannel = new BroadcastChannel("/log");
logChannel.onmessage = (event) => {
    //REM: Just appending it to the body.. lazy
    console.log(event.data, "from broadcast");
}

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

const STREAMING_APP = "http://localhost:5801"; //   "https://stream.peerchecker.com" // 
export const Canvas = () => {
    /*   const { peer } = usePeer();
      const params = useParams(); */

    return (
        <>
            <iframe id="1" style={{ width: "100%", height: "400px", border: 0 }} allow="camera; microphone; display-capture; autoplay; clipboard-write;" src={STREAMING_APP + "/#"}></iframe>
            <iframe id="1" style={{ width: "100%", height: "400px", border: 0 }} allow="camera; microphone; display-capture; autoplay; clipboard-write;" src={STREAMING_APP + "/#"}></iframe>

            {/*   <iframe id="2" style={{ width: "100%", height: "400px", border: 0 }} allow="camera; microphone; display-capture; autoplay; clipboard-write;" src={STREAMING_APP + "/#"}></iframe>
            <iframe id="3" style={{ width: "100%", height: "400px", border: 0 }} allow="camera; microphone; display-capture; autoplay; clipboard-write;" src={STREAMING_APP + "/#"}></iframe> */}
        </>
    );
};
