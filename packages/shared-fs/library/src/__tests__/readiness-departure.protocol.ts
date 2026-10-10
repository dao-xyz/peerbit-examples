// IPC messages between readiness-departure.node.test.ts and its child,
// readiness-departure.worker.ts (the peer R that departs, or, in design
// test 38, the owner of an access-controlled store).

/** One index row of a scope; a trust row's key is the relation id in hex. */
export interface DepartureRow {
    key: string;
    head: string;
}

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
      }
    | {
          /**
           * Test 38: R creates an access-controlled store (its own key the
           * root), grants one writer W (a second peer of the child) and
           * holds a file of W's and one of its own. W stops before R
           * reports, so the joiner reaches W's rows only through R. R's
           * responder answers.
           */
          type: "open-acl";
          /** Pubsub topic-root candidates of R and W (the parent's too). */
          candidates: string[];
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
          type: "acl-opened";
          address: string;
          /** The trust graph's log id in hex: the `TRUST_V1` log. */
          trustLogId: string;
          /** W's hashcode: the one key R granted. */
          writer: string;
          /** R's trust rows: the one edge. */
          trust: DepartureRow[];
          /** R's namespace rows, each with its entry's signer (hashcode). */
          namespace: Array<DepartureRow & { signer: string }>;
          /** The anchor host mode under `--import tsx` (S13). */
          anchorMode: string;
      }
    | {
          type: "fatal";
          message: string;
          stack?: string;
      };
