import argparse
import json
import math
import time
import urllib.request
from pathlib import Path

INSTRUCTION = "Instruct: 한국어 학습 답변과 사전의 한국어 의미가 같은 뜻인지 검색하세요.\nQuery: "


def embed(url: str, texts: list[str]) -> list[list[float]]:
    payload = json.dumps({"model": "Qwen/Qwen3-Embedding-8B-GGUF", "input": texts, "encoding_format": "float"}, ensure_ascii=False).encode()
    request = urllib.request.Request(url + "/v1/embeddings", data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        data = json.load(response)["data"]
    return [item["embedding"] for item in sorted(data, key=lambda item: item["index"])]


def cosine(a: list[float], b: list[float]) -> float:
    na = math.sqrt(sum(v * v for v in a))
    nb = math.sqrt(sum(v * v for v in b))
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def decision(pos: float, neg: float | None, pass_threshold: float, fail_threshold: float, margin: float) -> str:
    if neg is not None and neg >= pos and neg >= fail_threshold:
        return "negative"
    if pos >= pass_threshold and (neg is None or pos - neg >= margin):
        return "positive"
    if pos <= fail_threshold:
        return "negative"
    return "ambiguous"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:18081")
    parser.add_argument("--fixture", default=str(Path(__file__).parents[1] / "src-tauri" / "fixtures" / "semantic_calibration_ko.json"))
    parser.add_argument("--output", default=str(Path(__file__).parents[2] / "Results" / "semantic" / "calibration-result.json"))
    args = parser.parse_args()
    groups = json.loads(Path(args.fixture).read_text(encoding="utf-8"))

    documents = sorted({text for group in groups for text in group["positives"] + group["confusables"]})
    answers = sorted({case["answer"] for group in groups for case in group["cases"]})
    started = time.perf_counter()
    embed(args.url, [INSTRUCTION + answers[0]])
    first_embedding_ms = round((time.perf_counter() - started) * 1000, 1)
    started = time.perf_counter()
    document_vectors = embed(args.url, documents)
    canonical_batch_ms = round((time.perf_counter() - started) * 1000, 1)
    answer_vectors = embed(args.url, [INSTRUCTION + answer for answer in answers])
    lookup = dict(zip(documents + answers, document_vectors + answer_vectors))
    warmed = []
    for answer in answers[:10]:
        started = time.perf_counter()
        embed(args.url, [INSTRUCTION + answer])
        warmed.append((time.perf_counter() - started) * 1000)

    rows = []
    for group in groups:
        for case in group["cases"]:
            query = lookup[case["answer"]]
            positive = max(cosine(query, lookup[text]) for text in group["positives"])
            negative = max(cosine(query, lookup[text]) for text in group["confusables"])
            rows.append({"entry": group["id"], **case, "positive_score": positive, "negative_score": negative, "margin": positive - negative})

    best = None
    for pass_i in range(55, 96):
        for fail_i in range(30, pass_i):
            for margin_i in range(0, 31):
                thresholds = (pass_i / 100, fail_i / 100, margin_i / 100)
                predictions = [decision(row["positive_score"], row["negative_score"], *thresholds) for row in rows]
                no_negative_predictions = [decision(row["positive_score"], None, *thresholds) for row in rows]
                false_pass = sum(row["expected"] != "positive" and pred == "positive" for row, pred in zip(rows, predictions))
                no_negative_false_pass = sum(row["expected"] != "positive" and pred == "positive" for row, pred in zip(rows, no_negative_predictions))
                false_fail = sum(row["expected"] == "positive" and pred == "negative" for row, pred in zip(rows, predictions))
                missed_positive = sum(row["expected"] == "positive" and pred != "positive" for row, pred in zip(rows, predictions))
                ambiguous_wrong = sum(row["expected"] == "ambiguous" and pred != "ambiguous" for row, pred in zip(rows, predictions))
                negative_ambiguous = sum(row["expected"] == "negative" and pred == "ambiguous" for row, pred in zip(rows, predictions))
                score = (false_pass + no_negative_false_pass) * 1_000_000 + false_fail * 100_000 + missed_positive * 1_000 + ambiguous_wrong * 100 + negative_ambiguous
                candidate = (score, thresholds, predictions)
                if best is None or candidate[0] < best[0]:
                    best = candidate

    _, thresholds, predictions = best
    for row, pred in zip(rows, predictions):
        row["predicted"] = pred
    positives = [row for row in rows if row["expected"] == "positive"]
    negatives = [row for row in rows if row["expected"] == "negative"]
    ambiguous = [row for row in rows if row["expected"] == "ambiguous"]
    result = {
        "model": "Qwen3-Embedding-8B Q4_K_M",
        "dimension": len(document_vectors[0]),
        "case_count": len(rows),
        "first_embedding_ms": first_embedding_ms,
        "warmed_single_mean_ms": sum(warmed) / len(warmed),
        "warmed_single_max_ms": max(warmed),
        "canonical_count": len(documents),
        "canonical_batch_ms": canonical_batch_ms,
        "thresholds": {"pass": thresholds[0], "fail": thresholds[1], "minimum_margin": thresholds[2]},
        "positive_pass_rate": sum(row["predicted"] == "positive" for row in positives) / len(positives),
        "clear_negative_rejection_rate": sum(row["predicted"] == "negative" for row in negatives) / len(negatives),
        "ambiguous_rate": sum(row["predicted"] == "ambiguous" for row in rows) / len(rows),
        "antonym_confusable_false_pass_count": sum(row["category"] in {"antonym", "confusable"} and row["predicted"] == "positive" for row in rows),
        "no_explicit_negative_false_pass_count": sum(row["expected"] != "positive" and decision(row["positive_score"], None, *thresholds) == "positive" for row in rows),
        "false_positive_examples": [row for row in rows if row["expected"] != "positive" and row["predicted"] == "positive"],
        "false_negative_examples": [row for row in rows if row["expected"] == "positive" and row["predicted"] == "negative"],
        "ambiguous_accuracy": sum(row["predicted"] == "ambiguous" for row in ambiguous) / len(ambiguous),
        "rows": rows,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key != "rows"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
