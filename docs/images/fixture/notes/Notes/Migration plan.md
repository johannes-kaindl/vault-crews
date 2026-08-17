# Migration plan

We are moving the reporting stack off the old scheduler. The first batch of
twelve jobs runs on the new one since Monday; nothing has failed so far, but
the retry behaviour is still the old one because the config was copied over
verbatim.

Open: whether the nightly export keeps its window when the second batch moves.
