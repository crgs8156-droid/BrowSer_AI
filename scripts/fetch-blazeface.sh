#!/bin/bash
# Fetches the BlazeFace ONNX model into the extension's models/ directory.
# Primary: PINTO_model_zoo 030_BlazeFace (spec source; served from an S3 host that
# may be network-blocked). Fallback: a reachable end-to-end export with the SAME
# input shape ([1,3,128,128] NCHW) and graph-baked post-processing (threshold/NMS),
# so the runtime contract is identical.
set -e
OUT="$(dirname "$0")/../extension/src/perception/visual/models/blazeface.onnx"
mkdir -p "$(dirname "$OUT")"

try() {
  curl -sL --max-time 120 "$1" -o "$OUT" || return 1
  [ "$(head -c 2 "$OUT")" ] || return 1
  # ONNX files start with a protobuf field; reject 404/error bodies.
  if head -c 4096 "$OUT" | grep -qa "Not Found"; then return 1; fi
  echo "model: $OUT ($(stat -c%s "$OUT") bytes)"
}

if try "https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/030_BlazeFace/resources.tar.gz"; then
  echo "NOTE: the PINTO tarball is an archive — extract blazeface_front.onnx to $OUT"
elif try "https://raw.githubusercontent.com/manthi4/End-to-end-BlazeFace-Onnx/main/T_mpipe_bface_boxes_ops16.onnx"; then
  echo "source: manthi4/End-to-end-BlazeFace-Onnx (end-to-end export, NCHW input)"
else
  echo "FAILED: no reachable model mirror. Face detection degrades gracefully to 0 faces." >&2
  exit 1
fi
