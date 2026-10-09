// IPC messages between readiness-departure.node.test.ts and its child,
// readiness-departure.worker.ts (the peer R that departs).

/** Parent → child. */
export type DepartureCommand =
    | {
          type: "connect";
          /** Multiaddrs R dials (its only neighbours). */
          dial: string[];
          /**
           * Explicit pubsub topic-root candidates (hashcodes), the same set
           * on every peer of the scenario, so the fanout parent of R is
           * chosen by the test rather than by automatic candidate claims.
           */
          candidates: string[];
          /** libp2p peer ids R never connects to, directly or relayed. */
          deny: string[];
      }
    | {
          type: "open";
          /** The filesystem address R opens (a full replica). */
          address: string;
      };

/** Child → parent. */
export type DepartureReport =
    | {
          type: "hello";
          hash: string;
          peerId: string;
          /** R's TCP multiaddrs on the loopback interface. */
          addrs: string[];
          pid: number;
      }
    | { type: "connected" }
    | {
          type: "opened";
          /** The readiness RPC's topic as R sees it. */
          topic: string;
          /** The anchor host mode under `--import tsx` (S13). */
          anchorMode: string;
      }
    | {
          /** R's responder dropped an OPEN (R never answers). */
          type: "dropped";
          from?: string;
      }
    | {
          type: "fatal";
          message: string;
          stack?: string;
      };
