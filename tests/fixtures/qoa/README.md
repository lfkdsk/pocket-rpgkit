# QOA reference vector

`official-stereo.qoa` was encoded with the official
[`phoboslab/qoa`](https://github.com/phoboslab/qoa) C implementation at
commit `bc0589710ff6aa2f50e08fb4d0a815d567bc0f3e` (MIT). It contains 5,143
stereo frames at 22,050 Hz: one complete 5,120-frame QOA frame plus a
23-frame tail, including a final slice shorter than 20 samples.

`official-stereo.s16le` is the byte-for-byte output from that same revision's
`qoa_decode`. The runtime test compares every decoded channel sample rather
than comparing only a checksum.

The input frames are generated with unsigned integer arithmetic:

```c
left  = (short)(((i * 7919u) & 0xffffu) - 32768);
right = (short)(((i * 1237u + (i / 37) * 991u) & 0xffffu) - 32768);
```
