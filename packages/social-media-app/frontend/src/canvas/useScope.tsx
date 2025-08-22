import {
    createContext,
    useContext,
    useMemo,
    useState,
    JSX,
    useEffect,
} from "react";
import { usePeer } from "@peerbit/react";
import { Scope, createRootScope } from "@giga-app/interface";
import { concat } from "uint8arrays";

export interface ICanvasContext {
    scope?: Scope;
}


/**
 * Call this once per "root group" you want.
 * It returns a Provider and a hook bound to that root group.
 */
export function createScope(options?: { private?: boolean }) {
    const Ctx = createContext<ICanvasContext>(null as any);

    const useScope = () => useContext(Ctx);
    const ScopeProvider = ({ children }: { children: JSX.Element }) => {
        const { peer, loading: loadingPeer, persisted } = usePeer();
        const [scope, setScope] = useState<Scope | undefined>(undefined);
        const [isLoading, setIsLoading] = useState(true);


        // ensure we have a root
        useEffect(() => {
            if (!peer) {
                return;
            }

            if (options?.private) {
                const constructArgs = {
                    publicKey: peer.identity.publicKey,
                    seed: concat([
                        peer.identity.publicKey.bytes,
                        new TextEncoder().encode("draft"),
                    ]),
                };
                peer.open(new Scope(constructArgs), {
                    existing: "reuse",
                    args: { replicate: persisted },
                }).then((privateScope) => {
                    setScope(privateScope);
                    setIsLoading(false);
                });
                return;
            }
            peer.open(createRootScope(), {
                existing: "reuse",
                args: { replicate: persisted },
            }).then((publicScope) => {
                setScope(publicScope);
                setIsLoading(false);
            });
        }, [peer?.identity?.toString()]);

        const value = useMemo<ICanvasContext>(
            () => ({
                scope
            }),
            [
                scope,
                isLoading,
                loadingPeer,
            ]
        );

        return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
    };

    return { ScopeProvider, useScope };
}

export const PublicScope = createScope();
export const PrivateScope = createScope({ private: true });
const useScope = PublicScope.useScope;
export { useScope };
