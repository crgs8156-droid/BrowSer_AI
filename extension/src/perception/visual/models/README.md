# models/

`blazeface.onnx` — MediaPipe BlazeFace front, end-to-end ONNX export (graph-baked
0.7 confidence threshold + NMS; NCHW [1,3,128,128] input; [N,16] normalized output
rows). NOT committed — fetch via `scripts/fetch-blazeface.sh` (tries the PINTO source,
then a reachable mirror with an identical runtime contract).

Absence is a supported state: the face-blur engine degrades to zero faces and the
perception pipeline continues.
