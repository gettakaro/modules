# mini-games

Daily puzzles (Wordle, Hangman, Hot/Cold) and live chat rounds (Trivia, Scramble, Math race, Reaction race).

## External requests

When `triviaQuestionSource` is `api` (the default), live Trivia rounds fetch questions from the public
[Open Trivia Database](https://opentdb.com). The module therefore makes outbound HTTPS requests to `opentdb.com`
from Takaro. If a request fails, the module falls back to the custom question bank.

Set `triviaQuestionSource` to `custom` to use only your own question bank and make no external requests.
