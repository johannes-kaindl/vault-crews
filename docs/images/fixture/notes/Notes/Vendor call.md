# Vendor call

Acme Consulting walked us through their scheduler migration. Their advice was
to move the smallest job first and keep both schedulers running for a full
billing cycle — which is roughly what we are doing.

They also warned that retry storms show up in the second week, not the first.
