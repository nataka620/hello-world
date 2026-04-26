#!/usr/bin/env python3
"""Simple High & Low guessing game."""

from __future__ import annotations

import random


def ask_int(prompt: str) -> int:
    """Ask for an integer until valid input is provided."""
    while True:
        value = input(prompt).strip()
        if value.lstrip("-").isdigit():
            return int(value)
        print("数字を入力してね！")


def play_round() -> None:
    """Play one round of high and low."""
    answer = random.randint(1, 100)
    attempts = 0

    print("\n=== High & Low ===")
    print("1〜100の数字を当ててね。")

    while True:
        guess = ask_int("予想の数字: ")
        attempts += 1

        if guess < answer:
            print("もっと大きい！")
        elif guess > answer:
            print("もっと小さい！")
        else:
            print(f"正解！ {attempts}回で当たった！")
            break


def main() -> None:
    print("ハイアンドローへようこそ！")
    while True:
        play_round()
        again = input("もう1回やる？ (y/n): ").strip().lower()
        if again not in {"y", "yes"}:
            print("遊んでくれてありがとう！")
            break


if __name__ == "__main__":
    main()
