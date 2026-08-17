# Retry behaviour

The retry settings came over unchanged: five attempts, exponential backoff,
no jitter. That was fine on the old scheduler because jobs were spread out by
hand.

The new one starts everything at the top of the hour, so five simultaneous
retries hit the same window. Worth changing before the second batch moves.
