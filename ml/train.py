#!/usr/bin/env python3
"""
ml/train.py — train a small MLP postflop policy in PURE NUMPY (no torch/sklearn).

Loads the flat tensors written by ml/prep.ts, standardizes features (saving
mean/std), trains a 2-hidden-layer ReLU MLP with Adam + mini-batches and early
stopping on a validation split, and exports weights + standardization to a
TypeScript module the Chrome extension imports directly (base64 Float32 — no
fetch/CSP issues).

CRITICAL: accuracy is measured on LEGAL-MASKED argmax. The 5-way legal-action
mask lives in the feature vector itself (indices 32..36), so we read it straight
out of X (the RAW, pre-standardized features) and set illegal-action logits to
-inf before argmax. This makes the reported accuracy reflect realistic play.

Run:  python3 ml/train.py
"""
import base64
import json
import os
import struct
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT_TS = os.path.join(HERE, "..", "src", "core", "ml", "model.ts")

FEATURE_DIM = 37
NUM_ACTIONS = 5
ACTION_MASK_OFFSET = 32  # must match features.ts

H1 = 256
H2 = 128
EPOCHS = 40
BATCH = 512
LR = 1e-3
L2 = 1e-5
PATIENCE = 6
SEED = 1234

rng = np.random.default_rng(SEED)


def load(split):
    with open(os.path.join(DATA, f"{split}_shape.json")) as f:
        shape = json.load(f)
    n, dim = shape["n"], shape["dim"]
    X = np.fromfile(os.path.join(DATA, f"{split}_X.f32"), dtype=np.float32).reshape(n, dim)
    y = np.fromfile(os.path.join(DATA, f"{split}_y.u8"), dtype=np.uint8).astype(np.int64)
    return X, y


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def legal_mask(X_raw):
    """Extract the [N,5] legal-action mask from raw (un-standardized) features."""
    return X_raw[:, ACTION_MASK_OFFSET:ACTION_MASK_OFFSET + NUM_ACTIONS]


def masked_argmax(logits, mask):
    neg = np.where(mask > 0.5, logits, -1e30)
    return neg.argmax(axis=1)


class MLP:
    def __init__(self, d_in, h1, h2, d_out):
        # He init
        self.W1 = (rng.standard_normal((d_in, h1)) * np.sqrt(2.0 / d_in)).astype(np.float64)
        self.b1 = np.zeros(h1)
        self.W2 = (rng.standard_normal((h1, h2)) * np.sqrt(2.0 / h1)).astype(np.float64)
        self.b2 = np.zeros(h2)
        self.W3 = (rng.standard_normal((h2, d_out)) * np.sqrt(2.0 / h2)).astype(np.float64)
        self.b3 = np.zeros(d_out)
        self.params = ["W1", "b1", "W2", "b2", "W3", "b3"]
        # Adam state
        self.m = {p: np.zeros_like(getattr(self, p)) for p in self.params}
        self.v = {p: np.zeros_like(getattr(self, p)) for p in self.params}
        self.t = 0

    def forward(self, X):
        self.z1 = X @ self.W1 + self.b1
        self.a1 = np.maximum(0, self.z1)
        self.z2 = self.a1 @ self.W2 + self.b2
        self.a2 = np.maximum(0, self.z2)
        self.z3 = self.a2 @ self.W3 + self.b3
        return self.z3

    def backward(self, X, probs, y):
        n = X.shape[0]
        dz3 = probs.copy()
        dz3[np.arange(n), y] -= 1
        dz3 /= n
        dW3 = self.a2.T @ dz3 + L2 * self.W3
        db3 = dz3.sum(axis=0)
        da2 = dz3 @ self.W3.T
        dz2 = da2 * (self.z2 > 0)
        dW2 = self.a1.T @ dz2 + L2 * self.W2
        db2 = dz2.sum(axis=0)
        da1 = dz2 @ self.W2.T
        dz1 = da1 * (self.z1 > 0)
        dW1 = X.T @ dz1 + L2 * self.W1
        db1 = dz1.sum(axis=0)
        return {"W1": dW1, "b1": db1, "W2": dW2, "b2": db2, "W3": dW3, "b3": db3}

    def step(self, grads, lr):
        self.t += 1
        b1, b2, eps = 0.9, 0.999, 1e-8
        for p in self.params:
            g = grads[p]
            self.m[p] = b1 * self.m[p] + (1 - b1) * g
            self.v[p] = b2 * self.v[p] + (1 - b2) * (g * g)
            mhat = self.m[p] / (1 - b1 ** self.t)
            vhat = self.v[p] / (1 - b2 ** self.t)
            setattr(self, p, getattr(self, p) - lr * mhat / (np.sqrt(vhat) + eps))


def accuracy(model, Xs, X_raw, y):
    logits = model.forward(Xs)
    pred = masked_argmax(logits, legal_mask(X_raw))
    return (pred == y).mean()


def main():
    print("loading...")
    Xtr_raw, ytr = load("train")
    Xte_raw, yte = load("test")
    print(f"train={Xtr_raw.shape} test={Xte_raw.shape}")

    # train/val split
    n = Xtr_raw.shape[0]
    perm = rng.permutation(n)
    Xtr_raw, ytr = Xtr_raw[perm], ytr[perm]
    nval = max(2000, n // 20)
    Xval_raw, yval = Xtr_raw[:nval], ytr[:nval]
    Xtr_raw, ytr = Xtr_raw[nval:], ytr[nval:]

    # Standardize using TRAIN stats. Keep binary/mask columns stable: std=1 where
    # tiny variance so we don't blow them up.
    mean = Xtr_raw.mean(axis=0)
    std = Xtr_raw.std(axis=0)
    std[std < 1e-6] = 1.0
    Xtr = ((Xtr_raw - mean) / std).astype(np.float64)
    Xval = ((Xval_raw - mean) / std).astype(np.float64)
    Xte = ((Xte_raw - mean) / std).astype(np.float64)

    model = MLP(FEATURE_DIM, H1, H2, NUM_ACTIONS)

    best_val = -1.0
    best = None
    bad = 0
    ntr = Xtr.shape[0]
    for ep in range(EPOCHS):
        idx = rng.permutation(ntr)
        lr = LR * (0.5 ** (ep // 12))  # step decay
        for s in range(0, ntr, BATCH):
            bi = idx[s:s + BATCH]
            xb = Xtr[bi]
            yb = ytr[bi]
            logits = model.forward(xb)
            probs = softmax(logits)
            grads = model.backward(xb, probs, yb)
            model.step(grads, lr)

        tr_acc = accuracy(model, Xtr[:20000], Xtr_raw[:20000], ytr[:20000])
        val_acc = accuracy(model, Xval, Xval_raw, yval)
        print(f"epoch {ep+1:2d} lr={lr:.1e} train_acc={tr_acc:.4f} val_acc={val_acc:.4f}")

        if val_acc > best_val + 1e-4:
            best_val = val_acc
            best = {p: getattr(model, p).copy() for p in model.params}
            bad = 0
        else:
            bad += 1
            if bad >= PATIENCE:
                print(f"early stop at epoch {ep+1} (best val {best_val:.4f})")
                break

    # restore best
    if best:
        for p in model.params:
            setattr(model, p, best[p])

    tr_acc = accuracy(model, Xtr, Xtr_raw, ytr)
    val_acc = accuracy(model, Xval, Xval_raw, yval)
    te_acc = accuracy(model, Xte, Xte_raw, yte)
    print("=" * 50)
    print(f"FINAL (masked) train={tr_acc:.4f} val={val_acc:.4f} TEST={te_acc:.4f}")
    print("=" * 50)

    export_ts(model, mean, std, dict(train=float(tr_acc), val=float(val_acc), test=float(te_acc)))


def b64f32(arr):
    a = np.ascontiguousarray(arr.astype(np.float32))
    return base64.b64encode(a.tobytes()).decode("ascii")


def export_ts(model, mean, std, acc):
    layers = {
        "W1": (model.W1, list(model.W1.shape)),
        "b1": (model.b1, list(model.b1.shape)),
        "W2": (model.W2, list(model.W2.shape)),
        "b2": (model.b2, list(model.b2.shape)),
        "W3": (model.W3, list(model.W3.shape)),
        "b3": (model.b3, list(model.b3.shape)),
    }
    obj = {
        "featureDim": FEATURE_DIM,
        "numActions": NUM_ACTIONS,
        "dims": {k: v[1] for k, v in layers.items()},
        "accuracy": acc,
        "mean": b64f32(mean),
        "std": b64f32(std),
        "weights": {k: b64f32(v[0]) for k, v in layers.items()},
    }
    ts = (
        "// AUTO-GENERATED by ml/train.py — do not edit by hand.\n"
        "// Pure-numpy MLP postflop policy weights, base64-encoded little-endian Float32.\n"
        "// Loaded directly by src/core/ml/policy.ts (no fetch/CSP).\n"
        f"// Held-out TEST action-match accuracy (legal-masked): {acc['test']:.4f}\n\n"
        "export interface ModelData {\n"
        "  featureDim: number;\n"
        "  numActions: number;\n"
        "  dims: Record<string, number[]>;\n"
        "  accuracy: { train: number; val: number; test: number };\n"
        "  mean: string;\n"
        "  std: string;\n"
        "  weights: Record<string, string>;\n"
        "}\n\n"
        "export const MODEL: ModelData = " + json.dumps(obj) + ";\n"
    )
    with open(OUT_TS, "w") as f:
        f.write(ts)
    size = os.path.getsize(OUT_TS)
    print(f"wrote {OUT_TS} ({size/1024:.1f} KiB)")


if __name__ == "__main__":
    main()
