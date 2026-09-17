#include "../ios/vendor/lc3/common.h"

/* No ambient `sr`: each expression must use its own PCM sample-rate argument. */
_Static_assert(LC3_NT(LC3_SRATE_8K) == 10, "8 kHz temporal window");
_Static_assert(LC3_NT(LC3_SRATE_16K) == 20, "16 kHz temporal window");
_Static_assert(LC3_NT(LC3_SRATE_24K) == 30, "24 kHz temporal window");
_Static_assert(LC3_NT(LC3_SRATE_32K) == 40, "32 kHz temporal window");
_Static_assert(LC3_NT(LC3_SRATE_48K) == 60, "48 kHz temporal window");
