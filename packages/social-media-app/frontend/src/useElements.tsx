import { usePeer } from "@peerbit/react";
import React, {
    useContext,
    useEffect,
    useRef,
    useState,
    useReducer,
} from "react";
import { Element } from "@dao-xyz/social";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { sha256Sync } from '@peerbit/crypto'

interface IElementContext {
    current?: Element;
    path: Element[]
    loading: boolean;
}

export const ElementContext = React.createContext<IElementContext>({} as any);
export const useElements = () => useContext(ElementContext);

const ROOT_ID_SEED = new TextEncoder().encode("dao | xyz");

export const ElementProvider = ({ children }: { children: JSX.Element }) => {

    const { peer, loading: loadingPeer } = usePeer();
    const [current, setCurrent] = useState<Element>(undefined);
    const [path, setPath] = useState<Element[]>([]);
    const loading = useRef<Promise<void>>();
    const [isLoading, setIsLoading] = useState(false);
    const [update, forceUpdate] = useReducer((x) => x + 1, 0);
    const rlocation = useLocation();
    const params = useParams();
    const navigate = useNavigate()

    const memo = React.useMemo<IElementContext>(
        () => ({
            current,
            path,
            update,
            loading: isLoading || loadingPeer
        }),
        [
            current?.address,
            update,
            isLoading,
            loadingPeer
        ]
    );
    const updateRooms = (reset = true) => {

        current
        /*   let startLocation = window.location.hash;
          const maybeSetRooms = (rooms: Room[]) => {
              if (startLocation === window.location.hash) {
                  console.log("SET ROOMS", window.location.hash, startLocation);
                  setRooms(rooms);
              }
          };
          const newRoomPath = getRoomPathFromURL();
          setRoomPath(newRoomPath);
          document.title = newRoomPath.join(" / ") || "dao | xyz";
          if (reset) {
              maybeSetRooms([]);
              setIsLoading(true);
          }
  
          current.findRoomsByPath(newRoomPath)
              .then((result) => {
                  if (result.path.length === newRoomPath.length) {
                      return Promise.all(
                          result.rooms.map((room) =>
                              peer.open(room, { existing: "reuse" })
                          )
                      ).then((openRooms) => {
                          console.log("OPEN ROOMS?", openRooms);
                          maybeSetRooms(openRooms);
                          return openRooms;
                      });
                  } else {
                      maybeSetRooms([]);
                  }
              })
              .catch((e) => {
                  console.error(e);
              })
              .finally(() => {
                  setIsLoading(false);
                  forceUpdate();
              }); */
    };

    useEffect(() => {
        if (!current) {
            forceUpdate();
            return;
        }
        updateRooms(false);

        // TODO remove when https://github.com/dao-xyz/peerbit/issues/151 is solved
        const listener = () => {
            updateRooms(false);
        };
        setTimeout(() => {
            updateRooms(false);
        }, 3000);
        /* current.elements.events.addEventListener("change", listener);
        return () => {
            current.elements.events.removeEventListener("change", listener);
        }; */
    }, [current?.address, rlocation]);

    useEffect(() => {

        if (current && current.address === params.address || !peer) {
            return;
        }
        peer.open(
            params.address || new Element({
                id: sha256Sync(ROOT_ID_SEED)
            }),
            {
                timeout: 5000,
                existing: "reuse",
            },
        )
            .then(async (result) => {
                if (!params.address) {
                    // navigate to the expeected path
                    /*  result.replies..put(new ChatView({ id: sha256Sync(ROOT_ID_SEED), parentElement: result.address })).then(() => {
                         console.log("NAV!")
 
                     }) */
                    navigate("/p/" + result.address)


                }
                result.getPath().then((path) => {
                    console.log("SET CURRENT", result)
                    setPath(path)
                    setCurrent(result);
                    forceUpdate()
                })

                // resolve path

            })
            .then(() => {
                loading.current = undefined;
            });
    }, [peer?.identity?.toString(), params?.address]);

    return <ElementContext.Provider value={memo}>{children}</ElementContext.Provider>;
};
