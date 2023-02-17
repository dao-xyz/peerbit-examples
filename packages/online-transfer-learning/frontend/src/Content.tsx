import { usePeer } from "@dao-xyz/peerbit-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";

import * as tf from "@tensorflow/tfjs";
import { Button, CircularProgress, Grid, Typography } from "@mui/material";
import { P2PStorage } from "./io-utils";
import { ModelDatabase } from "./database";
import { browserLocalStorage } from "@tensorflow/tfjs-core/dist/io/local_storage";

/* const STATUS = document.getElementById('status');
const VIDEO = document.getElementById('webcam');
const ENABLE_CAM_BUTTON = document.getElementById('enableCam');
const RESET_BUTTON = document.getElementById('reset');
const TRAIN_BUTTON = document.getElementById('train');

const STOP_DATA_GATHER = -1; */
const MOBILE_NET_INPUT_WIDTH = 224;
const MOBILE_NET_INPUT_HEIGHT = 224;
const CLASS_NAMES = ["Class 1", "Class 2"];

function hasGetUserMedia() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

let trainingDataInputs: any[] = [];
let trainingDataOutputs: any[] = [];
let examplesCount: Map<number, number> = new Map();
function dataGatherLoop(
    video: HTMLVideoElement,
    outputState: number,
    imageNet: tf.GraphModel<string | tf.io.IOHandler>,
    condition: () => boolean,
    statusText: HTMLDivElement
) {
    console.log("gather!", condition());

    if (condition()) {
        let imageFeatures = tf.tidy(function () {
            let videoFrameAsTensor = tf.browser.fromPixels(video);
            let resizedTensorFrame = tf.image.resizeBilinear(
                videoFrameAsTensor,
                [MOBILE_NET_INPUT_HEIGHT, MOBILE_NET_INPUT_WIDTH],
                true
            );
            let normalizedTensorFrame = resizedTensorFrame.div(255);
            return (
                imageNet.predict(
                    normalizedTensorFrame.expandDims()
                ) as tf.Tensor
            ).squeeze();
        });

        trainingDataInputs.push(imageFeatures);
        trainingDataOutputs.push(outputState);

        // Intialize array index element if currently undefined.
        examplesCount.set(
            outputState,
            (examplesCount.get(outputState) || 0) + 1
        );

        statusText.innerText = "";
        for (let n = 0; n < CLASS_NAMES.length; n++) {
            statusText.innerText +=
                CLASS_NAMES[n] + " data count: " + examplesCount[n] + ". ";
        }
        window.requestAnimationFrame(() =>
            dataGatherLoop(video, outputState, imageNet, condition, statusText)
        );
    }
}

function predictLoop(
    video: HTMLVideoElement,
    model: tf.Sequential,
    imageNet: tf.GraphModel<string | tf.io.IOHandler>,
    condition: () => boolean,
    statusText: HTMLDivElement
) {
    if (condition) {
        tf.tidy(function () {
            let videoFrameAsTensor = tf.browser.fromPixels(video).div(255);
            let resizedTensorFrame = tf.image.resizeBilinear(
                videoFrameAsTensor.as3D(
                    videoFrameAsTensor.shape[0],
                    videoFrameAsTensor.shape[1],
                    videoFrameAsTensor.shape[2]
                ),
                [MOBILE_NET_INPUT_HEIGHT, MOBILE_NET_INPUT_WIDTH],
                true
            );

            let imageFeatures = imageNet.predict(
                resizedTensorFrame.expandDims()
            );
            let prediction = (
                model.predict(imageFeatures as any) as tf.Tensor<tf.Rank>
            ).squeeze();
            let highestIndex = prediction.argMax().arraySync();
            let predictionArray = prediction.arraySync();
            console.log(predictionArray);

            statusText.innerText =
                "Prediction: " +
                CLASS_NAMES[highestIndex as number] +
                " with " +
                Math.floor(predictionArray[highestIndex as number] * 100) +
                "% confidence";
        });

        window.requestAnimationFrame(() =>
            predictLoop(video, model, imageNet, condition, statusText)
        );
    }
}

async function train(model: tf.Sequential, storage: tf.io.IOHandler) {
    tf.util.shuffleCombo(trainingDataInputs, trainingDataOutputs);
    console.log(trainingDataInputs, trainingDataOutputs);
    let outputsAsTensor = tf.tensor1d(trainingDataOutputs, "int32");
    let oneHotOutputs = tf.oneHot(outputsAsTensor, CLASS_NAMES.length);
    let inputsAsTensor = tf.stack(trainingDataInputs);

    let results = await model.fit(inputsAsTensor, oneHotOutputs, {
        shuffle: true,
        batchSize: 5,
        epochs: 10,
        callbacks: { onEpochEnd: logProgress },
    });

    await model.save(storage);

    outputsAsTensor.dispose();
    oneHotOutputs.dispose();
    inputsAsTensor.dispose();
}

// predictLoop(video, model, imageNet, condition, statusText);

function logProgress(epoch, logs) {
    console.log("Data for epoch " + epoch, logs);
}

export const MODEL_ID = "V0";
export const MODEL_DATABASE_ID = "V0";

export const Content = () => {
    const { peer } = usePeer();
    const params = useParams();
    const status = useRef<HTMLDivElement>();
    const video = useRef<HTMLVideoElement>(null);
    const model = useRef<tf.Sequential>(null);
    const imageNetModel = useRef<tf.GraphModel<string | tf.io.IOHandler>>(null);
    const [processing, setProcessing] = useState(false);
    const stopProcessing = useRef<() => void>(null);
    const [loading, setLoading] = useState(false);
    const loadedModel = useRef(false);
    const [usingCamera, setUsingCamera] = useState(false);
    const p2pStorage = useRef<P2PStorage>();
    const [modelDate, setModelDate] = useState<Date>(null);

    useEffect(() => {
        if (p2pStorage.current || !peer) {
            return;
        }
        console.log("HERE!");
        setProcessing(true);
        peer.open(new ModelDatabase({ id: MODEL_DATABASE_ID })).then(
            async (db) => {
                await db.load();
                console.log("loaded!", db.address.toString());
                p2pStorage.current = new P2PStorage(db, MODEL_ID);
                setProcessing(false);

                //p2pStorage.current = browserLocalStorage('./some/path');
            }
        );
    }, [peer?.id.toString()]);

    const enableCam = () => {
        if (!video.current) {
            return;
        }

        if (hasGetUserMedia()) {
            // getUsermedia parameters.
            const constraints = {
                video: true,
                width: 640,
                height: 480,
            };

            // Activate the webcam stream.
            navigator.mediaDevices
                .getUserMedia(constraints)
                .then(function (stream) {
                    video.current.srcObject = stream;
                    video.current.addEventListener("loadeddata", function () {
                        setUsingCamera(true);
                        // videoPlaying = true;
                        // ENABLE_CAM_BUTTON.classList.add('removed');
                    });
                });
        } else {
            console.warn("getUserMedia() is not supported by your browser");
        }
    };

    useEffect(() => {
        if (loadedModel.current) {
            return;
        }
        loadedModel.current = true;
        setLoading(true);
        const fn = async () => {
            const imageNetSmall = await tf.loadGraphModel(
                "https://tfhub.dev/google/tfjs-model/imagenet/mobilenet_v3_small_100_224/feature_vector/5/default/1",
                { fromTFHub: true }
            );
            if (status?.current) {
                status.current.innerText = "";
            }
            // Warm up the model by passing zeros through it once.
            tf.tidy(function () {
                let answer = imageNetSmall.predict(
                    tf.zeros([
                        1,
                        MOBILE_NET_INPUT_HEIGHT,
                        MOBILE_NET_INPUT_WIDTH,
                        3,
                    ])
                );
                console.log(answer);
            });

            imageNetModel.current = imageNetSmall;

            console.log('Loaded image net')
            let tfModel = tf.sequential();
            tfModel.add(
                tf.layers.dense({
                    inputShape: [1024],
                    units: 128,
                    activation: "relu",
                })
            );
            tfModel.add(
                tf.layers.dense({
                    units: CLASS_NAMES.length,
                    activation: "softmax",
                })
            );

            tfModel.summary();

            // Compile the model with the defined optimizer and specify a loss function to use.
            tfModel.compile({
                // Adam changes the learning rate over time which is useful.
                optimizer: "adam",
                // Use the correct loss function. If 2 classes of data, must use binaryCrossentropy.
                // Else categoricalCrossentropy is used if more than 2 classes.
                loss:
                    CLASS_NAMES.length === 2
                        ? "binaryCrossentropy"
                        : "categoricalCrossentropy",
                // As this is a classification problem you can record accuracy in the logs too!
                metrics: ["accuracy"],
            });
            model.current = tfModel;
            setLoading(false);
        };
        fn();
    }, []);

    const updateModelDate = () => {
        p2pStorage.current.db.models.index.get(MODEL_ID).then((r) => {
            setModelDate(
                new Date(Number(r.results[0].context.modified / 1000n))
            );
        });
    };

    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !params.node || !params.identity) {
            return;
        }
    }, [peer?.id, params?.node]);

    return (
        <>
            <Grid container direction="column" spacing={2} margin={4}>
                <Grid item container direction="column">
                    <Grid item>
                        <Typography ref={status}></Typography>
                    </Grid>
                    <Grid item>
                        {modelDate ? (
                            <Typography>{modelDate.toUTCString()}</Typography>
                        ) : (
                            <Typography>No active model</Typography>
                        )}
                    </Grid>
                </Grid>
                <Grid item>
                    <video ref={video} autoPlay muted></video>
                </Grid>
                {loading && <CircularProgress />}

                <Grid item container direction="column">
                    <Grid item>
                        <Button
                            disabled={usingCamera}
                            onClick={() => enableCam()}
                        >
                            Enable Webcam
                        </Button>
                    </Grid>
                    <Grid item>
                        {CLASS_NAMES.map((className) => {
                            return (
                                <Button
                                    disabled={!usingCamera || processing}
                                    key={className}
                                    onClick={() => {
                                        setProcessing(true);
                                        let gather = true;
                                        stopProcessing.current = () => {
                                            gather = false;
                                            setProcessing(false);
                                        };
                                        dataGatherLoop(
                                            video.current,
                                            CLASS_NAMES.indexOf(className),
                                            imageNetModel.current,
                                            () => gather,
                                            status.current
                                        );
                                    }}
                                >
                                    Gather for: {className}
                                </Button>
                            );
                        })}
                        <Button
                            id="train"
                            disabled={processing}
                            onClick={() => {
                                setProcessing(true);
                                train(model.current, p2pStorage.current).then(
                                    () => {
                                        updateModelDate();
                                        setProcessing(false);
                                    }
                                );
                            }}
                        >
                            Train
                        </Button>

                        <Button
                            id="predict"
                            disabled={!usingCamera || processing || !modelDate}
                            onClick={() => {
                                setProcessing(true);
                                let predict = true;
                                stopProcessing.current = () => {
                                    predict = false;
                                    setProcessing(false);
                                };
                                predictLoop(
                                    video.current,
                                    model.current,
                                    imageNetModel.current,
                                    () => predict,
                                    status.current
                                );
                            }}
                        >
                            Predict
                        </Button>
                    </Grid>
                    <Grid item>
                        <Button
                            disabled={!processing}
                            onClick={stopProcessing.current}
                        >
                            Stop
                        </Button>
                        <Button
                            onClick={() => {
                                tf.loadLayersModel(p2pStorage.current).then(
                                    (loaded) => {
                                        console.log("Loaded model", loaded);
                                        const sequential =
                                            loaded as tf.Sequential;
                                        sequential.compile({
                                            // Adam changes the learning rate over time which is useful.
                                            optimizer: "adam",
                                            // Use the correct loss function. If 2 classes of data, must use binaryCrossentropy.
                                            // Else categoricalCrossentropy is used if more than 2 classes.
                                            loss:
                                                CLASS_NAMES.length === 2
                                                    ? "binaryCrossentropy"
                                                    : "categoricalCrossentropy",
                                            // As this is a classification problem you can record accuracy in the logs too!
                                            metrics: ["accuracy"],
                                        });
                                        model.current = sequential;
                                        updateModelDate();
                                    }
                                );
                            }}
                        >
                            Sync latest
                        </Button>
                        <Button id="reset">Reset</Button>
                    </Grid>
                </Grid>
            </Grid>
        </>
    );
};
