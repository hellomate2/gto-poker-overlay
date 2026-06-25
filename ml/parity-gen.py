#!/usr/bin/env python3
"""
ml/parity-gen.py — train/serve skew guard generator.

Loads the COMMITTED model weights + saved mean/std (decoded from src/core/ml/model.ts
by ml/export-weights.ts into ml/_weights.json) and a set of fixed RAW feature
vectors, then recomputes the model logits with the SAME math as ml/train.py /
policy.ts (standardize -> dense+ReLU -> dense+ReLU -> dense). Writes the expected
logits to tests/fixtures/parity-vectors.json.

tests/ml-parity.test.ts then runs the committed TS forward pass on the identical
raw vectors and asserts the logits match these numpy reference logits to a tight
tolerance — proving the shipped TS inference == the trained numpy model.

Run (after `npx tsx ml/export-weights.ts`):  python3 ml/parity-gen.py
"""
import json
import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS = os.path.join(HERE, "_weights.json")
RAW_IN = os.path.join(HERE, "..", "tests", "fixtures", "parity-inputs.json")
OUT = os.path.join(HERE, "..", "tests", "fixtures", "parity-vectors.json")

def main():
    with open(WEIGHTS) as f:
        m = json.load(f)
    dims = m["dims"]
    # Derive the feature dim from the model itself (W1 is [in, h1]) so this never
    # goes stale when the encoder adds features.
    FEATURE_DIM = dims["W1"][0]
    mean = np.array(m["mean"], dtype=np.float32)
    std = np.array(m["std"], dtype=np.float32)

    def mat(name):
        d = dims[name]
        return np.array(m["weights"][name], dtype=np.float32).reshape(d)

    def vec(name):
        return np.array(m["weights"][name], dtype=np.float32)

    W1, b1 = mat("W1"), vec("b1")
    W2, b2 = mat("W2"), vec("b2")
    W3, b3 = mat("W3"), vec("b3")

    with open(RAW_IN) as f:
        raw_inputs = json.load(f)  # list of FEATURE_DIM-length arrays (RAW features)

    X = np.array(raw_inputs, dtype=np.float32)
    assert X.shape[1] == FEATURE_DIM, X.shape

    # SAME math as policy.ts / train.py: standardize then 2 ReLU layers + linear.
    Xs = (X - mean) / std
    a1 = np.maximum(0.0, Xs @ W1 + b1)
    a2 = np.maximum(0.0, a1 @ W2 + b2)
    logits = a2 @ W3 + b3  # pre-mask, pre-softmax

    out = {
        "inputs": raw_inputs,            # raw feature vectors (the TS test re-uses these)
        "expectedLogits": logits.tolist(),
    }
    with open(OUT, "w") as f:
        json.dump(out, f)
    print(f"wrote {OUT} — {logits.shape[0]} vectors x {logits.shape[1]} logits")


if __name__ == "__main__":
    main()
