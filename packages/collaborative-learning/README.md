# P2P Model learning
![demo](./demo.gif)

This project uses Peerbit to share model weights between peers. 

Last write wins. Which mean the one who trained the latest model will superseed the previous models.


Things that is missing from the demo, but should be added:

- Create different models based on some url param. /address/v0
- Implement privacy using Peerbit features
- Access control
- All-reduce strategy for merging weights, instead of "last write wins"
