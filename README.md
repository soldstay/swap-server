# Liquid Swap Server

A nodejs express server that sets up some basic API endpoints to communicate with the <a href="https://github.com/Blockstream/liquid-swap/">liquid-swap</a> python tool

GET /proposal
POST /acceptance

The server also fetches the latest BTC/USDt bid and ask prices from binance via websocket and uses them to decide when to finalize any accepted transactions it's received. Completed and pending transactions are stored in a leveldb database and can be subscribed to by websocket on port 8182.
