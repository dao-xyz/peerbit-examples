import { waitFor } from '@peerbit/time'
import { v4 as uuid } from 'uuid';


interface Identifiable {
    id: string
}

interface ResizeMessage extends Identifiable {
    type: "size";
    width: number;
    height: number;
}

interface NavigationEvent extends Identifiable {
    type: "navigate";
    to: string;
}
/* 

interface IdEvent extends Identifiable {

    type: "id";
}
 */
interface WrappedMessage<T extends ResizeMessage | NavigationEvent> {
    type: 'dao-xyz-app-sdk'
    message: T
}

const filterMessage = (message: WrappedMessage<any>) => {
    return message.type === 'dao-xyz-app-sdk';
}


const CLIENT_ID_SEARCH_PARAM = "frame_id"

export class AppClient {

    public id: string
    private listener: (message: MessageEvent) => void;

    constructor(
        readonly properties: {
            targetOrigin: string;
            onResize: (event: ResizeMessage) => void;
        }
    ) {
        const clientId = new URL(globalThis.location.href).searchParams.get(CLIENT_ID_SEARCH_PARAM);
        if (!clientId) {
            throw new Error("Missing client id from url: " + globalThis.location.href)
        }
        this.id = clientId;

        this.listener = (message) => {
            if (!filterMessage(message.data)) {
                return;
            }

            const data = message.data as WrappedMessage<(ResizeMessage)>;
            if (data.message.type === "size") {
                properties.onResize(data.message);
            }
        };
        globalThis.addEventListener("message", this.listener);
        /*   const message: WrappedMessage<IdEvent> = { type: 'dao-xyz-app-sdk', message: { id: this.id = uuid(), type: 'id' } };
          this.send(message); // Tell the parent what our id is
   */
    }



    resize(size: { width: number, height: number }) {
        const message: WrappedMessage<ResizeMessage> = { type: 'dao-xyz-app-sdk', message: { id: this.id!, type: 'size', ...size } };
        this.send(message)
    }

    navigate(navigation: { to: string }) {
        const message: WrappedMessage<NavigationEvent> = { type: 'dao-xyz-app-sdk', message: { id: this.id!, type: 'navigate', ...navigation } };
        this.send(message)
    }

    send(message: WrappedMessage<any>) {
        (globalThis.top || globalThis).postMessage(
            message,
            this.properties.targetOrigin
        );
    }

    stop() {
        globalThis.removeEventListener("message", this.listener);
    }
}

export class AppHost {
    private listener: (message: MessageEvent) => void;
    clientId: string
    clientSource: MessageEventSource | null
    constructor(
        readonly properties: {
            onResize: (event: ResizeMessage) => void;
            onNavigate: (event: NavigationEvent) => void;
        }
    ) {

        this.clientId = uuid()
        this.listener = (message) => {
            if (!filterMessage(message.data)) {
                return;
            }

            const dataMessage = message.data as WrappedMessage<ResizeMessage | NavigationEvent>;
            const data = dataMessage.message;

            /*    if (data.type === "id") {
                   console.log(message.origin)
                   this.clientId = data.id;
                   this.clientSource = message.source;
   
                   if (!this.clientSource) {
                       throw new Error("Missing event source for child frame")
                   }
                   return;
               } */

            if (data.id !== this.clientId) {
                return // Message not for me!
            }

            if (data.type === "size") {
                properties.onResize(data);
            } else if (data.type === "navigate") {
                properties.onNavigate(data);
            }
        };
        globalThis.addEventListener("message", this.listener);

    }



    transformClientUrl(url: string) {
        const parsedUrl = new URL(url)
        parsedUrl.searchParams.append(CLIENT_ID_SEARCH_PARAM, this.clientId)
        return parsedUrl.toString()
    }

    private checkId() {
        if (!this.clientId) {
            throw new Error("Missing client id")
        }

        if (!this.clientSource) {
            throw new Error("Missing client source")
        }
    }

    private async waitForId() {
        await waitFor(() => this.clientId)
    }


    resize(size: { width: number, height: number }) {
        this.checkId();
        const message: WrappedMessage<ResizeMessage> = { type: 'dao-xyz-app-sdk', message: { id: this.clientId!, type: 'size', ...size } };
        this.clientSource!.postMessage(message);
    }

    stop() {
        globalThis.removeEventListener("message", this.listener);
    }
}
