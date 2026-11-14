"""SPHEREx explorer backend."""

import os

# The small cutout worker should not fan out across every available CPU core.
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_name, "1")
