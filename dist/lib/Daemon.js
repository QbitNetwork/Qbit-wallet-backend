"use strict";
// Copyright (c) 2018-2020, Zpalmtree
// Copyright (c) 2022-2023, Dave Brennan
//
// Please see the included LICENSE file for more information.
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Daemon = void 0;
const _ = require("lodash");
const request = require("request-promise-native");
const events_1 = require("events");
const turtlecoin_utils_1 = require("turtlecoin-utils");
const http = require("http");
const https = require("https");
const Assert_1 = require("./Assert");
const Config_1 = require("./Config");
const ValidateParameters_1 = require("./ValidateParameters");
const Logger_1 = require("./Logger");
const WalletError_1 = require("./WalletError");
const Types_1 = require("./Types");
/**
 * @noInheritDoc
 */
class Daemon extends events_1.EventEmitter {
    /**
     * @param host The host to access the API on. Can be an IP, or a URL, for
     *             example, 1.1.1.1, or blockapi.qbitconnect.com
     *
     * @param port The port to access the API on for Qbit is 20101
     *             daemon, 80 for a HTTP api, or 443 for a HTTPS api.
     *
     * @param ssl        You can optionally specify whether this API supports
     *                   ssl/tls/https to save a couple of requests.
     *                   If you're not sure, do not specify this parameter -
     *                   we will work it out automatically.
     */
    constructor(host, port, ssl, useRawBlocks) {
        super();
        /**
         * Whether we should use https for our requests
         */
        this.ssl = true;
        /**
         * Have we determined if we should be using ssl or not?
         */
        this.sslDetermined = false;
        /**
         * The address node fees will go to
         */
        this.feeAddress = '';
        /**
         * The amount of the node fee in Bits
         */
        this.feeAmount = 0;
        /**
         * The amount of blocks the daemon we're connected to has
         */
        this.localDaemonBlockCount = 0;
        /**
         * The amount of blocks in the Qbit Network
         */
        this.networkBlockCount = 0;
        /**
         * The amount of peers we have, incoming+outgoing
         */
        this.peerCount = 0;
        /**
         * The hashrate of the last known local block
         */
        this.lastKnownHashrate = 0;
        /**
         * The number of blocks to download per /getwalletsyncdata request
         */
        this.blockCount = 100;
        this.config = new Config_1.Config();
        this.httpAgent = new http.Agent({
            keepAlive: true,
            keepAliveMsecs: 20000,
            maxSockets: Infinity,
        });
        this.httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 20000,
            maxSockets: Infinity,
        });
        /**
         * Last time the network height updated. If this goes over the configured
         * limit, we'll emit deadnode.
         */
        this.lastUpdatedNetworkHeight = new Date();
        /**
         * Last time the daemon height updated. If this goes over the configured
         * limit, we'll emit deadnode.
         */
        this.lastUpdatedLocalHeight = new Date();
        /**
         * Did our last contact with the daemon succeed. Set to true initially
         * so initial failure to connect will fire disconnect event.
         */
        this.connected = true;
        this.useRawBlocks = true;
        this.setMaxListeners(0);
        Assert_1.assertString(host, 'host');
        Assert_1.assertNumber(port, 'port');
        Assert_1.assertBooleanOrUndefined(ssl, 'ssl');
        Assert_1.assertBooleanOrUndefined(useRawBlocks, 'useRawBlocks');
        this.host = host;
        this.port = port;
        /* Raw IP's very rarely support SSL. This fixes the warning from
           https://github.com/nodejs/node/pull/23329 */
        if (/^(?!0)(?!.*\.$)((1?\d?\d|25[0-5]|2[0-4]\d)(\.|$)){4}$/.test(this.host) && ssl === undefined) {
            ssl = false;
        }
        if (ssl !== undefined) {
            this.ssl = ssl;
            this.sslDetermined = true;
        }
        if (useRawBlocks !== undefined) {
            this.useRawBlocks = useRawBlocks;
        }
    }
    updateConfig(config) {
        this.config = Config_1.MergeConfig(config);
        this.blockCount = this.config.blocksPerDaemonRequest;
    }
    /**
     * Get the amount of blocks the network has
     */
    getNetworkBlockCount() {
        return this.networkBlockCount;
    }
    /**
     * Get the amount of blocks the daemon we're connected to has
     */
    getLocalDaemonBlockCount() {
        return this.localDaemonBlockCount;
    }
    /**
     * Initialize the daemon and the fee info
     */
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            /* Note - if one promise throws, the other will be cancelled */
            yield Promise.all([this.updateDaemonInfo(), this.updateFeeInfo()]);
            if (this.networkBlockCount === 0) {
                this.emit('deadnode');
            }
        });
    }
    /**
     * Update the daemon info
     */
    updateDaemonInfo() {
        return __awaiter(this, void 0, void 0, function* () {
            let info;
            const haveDeterminedSsl = this.sslDetermined;
            try {
                [info] = yield this.makeGetRequest('/info');
            }
            catch (err) {
                Logger_1.logger.log('Failed to update daemon info: ' + err.toString(), Logger_1.LogLevel.INFO, [Logger_1.LogCategory.DAEMON]);
                const diff1 = (new Date().getTime() - this.lastUpdatedNetworkHeight.getTime()) / 1000;
                const diff2 = (new Date().getTime() - this.lastUpdatedLocalHeight.getTime()) / 1000;
                if (diff1 > this.config.maxLastUpdatedNetworkHeightInterval
                    || diff2 > this.config.maxLastUpdatedLocalHeightInterval) {
                    this.emit('deadnode');
                }
                return;
            }
            /* Possibly determined daemon type was HTTPS, got a valid response,
               but not valid data. Manually set to http and try again. */
            if (info.height === undefined && !haveDeterminedSsl) {
                this.sslDetermined = true;
                this.ssl = false;
                const diff1 = (new Date().getTime() - this.lastUpdatedNetworkHeight.getTime()) / 1000;
                const diff2 = (new Date().getTime() - this.lastUpdatedLocalHeight.getTime()) / 1000;
                if (diff1 > this.config.maxLastUpdatedNetworkHeightInterval
                    || diff2 > this.config.maxLastUpdatedLocalHeightInterval) {
                    this.emit('deadnode');
                }
                return this.updateDaemonInfo();
            }
            if (this.localDaemonBlockCount !== info.height
                || this.networkBlockCount !== info.networkHeight) {
                this.emit('heightchange', info.height, info.networkHeight);
                this.lastUpdatedNetworkHeight = new Date();
                this.lastUpdatedLocalHeight = new Date();
            }
            else {
                const diff1 = (new Date().getTime() - this.lastUpdatedNetworkHeight.getTime()) / 1000;
                const diff2 = (new Date().getTime() - this.lastUpdatedLocalHeight.getTime()) / 1000;
                if (diff1 > this.config.maxLastUpdatedNetworkHeightInterval
                    || diff2 > this.config.maxLastUpdatedLocalHeightInterval) {
                    this.emit('deadnode');
                }
            }
            this.localDaemonBlockCount = info.height;
            this.networkBlockCount = info.networkHeight;
            if (this.networkBlockCount > 0) {
                this.networkBlockCount--;
            }
            this.peerCount = info.incomingConnections + info.outgoingConnections;
            this.lastKnownHashrate = info.hashrate;
        });
    }
    /**
     * Get the node fee and address
     */
    nodeFee() {
        return [this.feeAddress, this.feeAmount];
    }
    /**
     * @param blockHashCheckpoints  Hashes of the last known blocks. Later
     *                              blocks (higher block height) should be
     *                              ordered at the front of the array.
     *
     * @param startHeight           Height to start taking blocks from
     * @param startTimestamp        Block timestamp to start taking blocks from
     *
     * Gets blocks from the daemon. Blocks are returned starting from the last
     * known block hash (if higher than the startHeight/startTimestamp)
     */
    getWalletSyncData(blockHashCheckpoints, startHeight, startTimestamp) {
        return __awaiter(this, void 0, void 0, function* () {
            let data;
            const endpoint = this.useRawBlocks ? '/sync/raw' : '/sync';
            try {
                [data] = yield this.makePostRequest(endpoint, {
                    count: this.blockCount,
                    checkpoints: blockHashCheckpoints,
                    skipCoinbaseTransactions: !this.config.scanCoinbaseTransactions,
                    height: startHeight,
                    timestamp: startTimestamp,
                });
            }
            catch (err) {
                this.blockCount = Math.ceil(this.blockCount / 4);
                Logger_1.logger.log(`Failed to get wallet sync data: ${err.toString()}. Lowering block count to ${this.blockCount}`, Logger_1.LogLevel.INFO, [Logger_1.LogCategory.DAEMON]);
                return [[], false];
            }
            /* The node is not dead if we're fetching blocks. */
            if (data.blocks.length >= 0) {
                Logger_1.logger.log(`Fetched ${data.blocks.length} blocks from the daemon`, Logger_1.LogLevel.DEBUG, [Logger_1.LogCategory.DAEMON]);
                if (this.blockCount !== this.config.blocksPerDaemonRequest) {
                    this.blockCount = Math.min(this.config.blocksPerDaemonRequest, this.blockCount * 2);
                    Logger_1.logger.log(`Successfully fetched sync data, raising block count to ${this.blockCount}`, Logger_1.LogLevel.DEBUG, [Logger_1.LogCategory.DAEMON]);
                }
                this.lastUpdatedNetworkHeight = new Date();
                this.lastUpdatedLocalHeight = new Date();
            }
            const blocks = this.useRawBlocks
                ? yield this.rawBlocksToBlocks(data.blocks)
                : data.blocks.map(Types_1.Block.fromJSON);
            if (data.synced && data.topBlock && data.topBlock.height && data.topBlock.hash) {
                return [blocks, data.topBlock];
            }
            return [blocks, true];
        });
    }
    /**
     * @returns Returns a mapping of transaction hashes to global indexes
     *
     * Get global indexes for the transactions in the range
     * [startHeight, endHeight]
     */
    getGlobalIndexesForRange(startHeight, endHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const [data] = yield this.makeGetRequest(`/indexes/${startHeight}/${endHeight}`);
                const indexes = new Map();
                for (const index of data) {
                    indexes.set(index.hash, index.indexes);
                }
                return indexes;
            }
            catch (err) {
                Logger_1.logger.log('Failed to get global indexes: ' + err.toString(), Logger_1.LogLevel.ERROR, Logger_1.LogCategory.DAEMON);
                return new Map();
            }
        });
    }
    getCancelledTransactions(transactionHashes) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const [data] = yield this.makePostRequest('/transaction/status', transactionHashes);
                return data.notFound || [];
            }
            catch (err) {
                Logger_1.logger.log('Failed to get transactions status: ' + err.toString(), Logger_1.LogLevel.ERROR, Logger_1.LogCategory.DAEMON);
                return [];
            }
        });
    }
    /**
     * Gets random outputs for the given amounts. requestedOuts per. Usually mixin+1.
     *
     * @returns Returns an array of amounts to global indexes and keys. There
     *          should be requestedOuts indexes if the daemon fully fulfilled
     *          our request.
     */
    getRandomOutputsByAmount(amounts, requestedOuts) {
        return __awaiter(this, void 0, void 0, function* () {
            let data;
            try {
                [data] = yield this.makePostRequest('/indexes/random', {
                    amounts: amounts,
                    count: requestedOuts,
                });
            }
            catch (err) {
                Logger_1.logger.log('Failed to get random outs: ' + err.toString(), Logger_1.LogLevel.ERROR, [Logger_1.LogCategory.TRANSACTIONS, Logger_1.LogCategory.DAEMON]);
                return [];
            }
            const outputs = [];
            for (const output of data) {
                const indexes = [];
                for (const outs of output.outputs) {
                    indexes.push([outs.index, outs.key]);
                }
                /* Sort by output index to make it hard to determine real one */
                outputs.push([output.amount, _.sortBy(indexes, ([index]) => index)]);
            }
            return outputs;
        });
    }
    sendTransaction(rawTransaction) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const [result, statusCode] = yield this.makePostRequest('/transaction', rawTransaction);
                if (statusCode === 202) {
                    return WalletError_1.SUCCESS;
                }
                if (result && result.error && result.error.code) {
                    const code = WalletError_1.WalletErrorCode[result.error.code] !== undefined
                        ? result.error.code
                        : WalletError_1.WalletErrorCode.UNKNOWN_ERROR;
                    return new WalletError_1.WalletError(code, result.error.message);
                }
                return new WalletError_1.WalletError(WalletError_1.WalletErrorCode.UNKNOWN_ERROR);
            }
            catch (err) {
                Logger_1.logger.log('Failed to send transaction: ' + err.toString(), Logger_1.LogLevel.ERROR, [Logger_1.LogCategory.TRANSACTIONS, Logger_1.LogCategory.DAEMON]);
                return new WalletError_1.WalletError(WalletError_1.WalletErrorCode.DAEMON_ERROR, err.toString());
            }
        });
    }
    getConnectionInfo() {
        return {
            host: this.host,
            port: this.port,
            ssl: this.ssl,
            sslDetermined: this.sslDetermined,
        };
    }
    getConnectionString() {
        return this.host + ':' + this.port;
    }
    rawBlocksToBlocks(rawBlocks) {
        return __awaiter(this, void 0, void 0, function* () {
            const result = [];
            for (const rawBlock of rawBlocks) {
                const block = yield turtlecoin_utils_1.Block.from(rawBlock.blob, this.config);
                this.emit('rawblock', block);
                this.emit('rawtransaction', block.minerTransaction);
                let coinbaseTransaction;
                if (this.config.scanCoinbaseTransactions) {
                    const keyOutputs = [];
                    for (const output of block.minerTransaction.outputs) {
                        if (output.type === turtlecoin_utils_1.TransactionOutputs.OutputType.KEY) {
                            const o = output;
                            keyOutputs.push(new Types_1.KeyOutput(o.key, o.amount.toJSNumber()));
                        }
                    }
                    coinbaseTransaction = new Types_1.RawCoinbaseTransaction(keyOutputs, yield block.minerTransaction.hash(), block.minerTransaction.publicKey, block.minerTransaction.unlockTime > Number.MAX_SAFE_INTEGER
                        ? block.minerTransaction.unlockTime.toJSNumber()
                        : block.minerTransaction.unlockTime);
                }
                const transactions = [];
                for (const tx of rawBlock.transactions) {
                    const rawTX = yield turtlecoin_utils_1.Transaction.from(tx);
                    this.emit('rawtransaction', tx);
                    const keyOutputs = [];
                    const keyInputs = [];
                    for (const output of rawTX.outputs) {
                        if (output.type === turtlecoin_utils_1.TransactionOutputs.OutputType.KEY) {
                            const o = output;
                            keyOutputs.push(new Types_1.KeyOutput(o.key, o.amount.toJSNumber()));
                        }
                    }
                    for (const input of rawTX.inputs) {
                        if (input.type === turtlecoin_utils_1.TransactionInputs.InputType.KEY) {
                            const i = input;
                            keyInputs.push(new Types_1.KeyInput(i.amount.toJSNumber(), i.keyImage));
                        }
                    }
                    transactions.push(new Types_1.RawTransaction(keyOutputs, yield rawTX.hash(), rawTX.publicKey, rawTX.unlockTime > Number.MAX_SAFE_INTEGER
                        ? rawTX.unlockTime.toJSNumber()
                        : rawTX.unlockTime, rawTX.paymentId || '', keyInputs));
                }
                result.push(new Types_1.Block(transactions, block.height, yield block.hash(), Math.floor(block.timestamp.getTime() / 1000), coinbaseTransaction));
            }
            return result;
        });
    }
    /**
     * Update the fee address and amount
     */
    updateFeeInfo() {
        return __awaiter(this, void 0, void 0, function* () {
            let feeInfo;
            try {
                [feeInfo] = yield this.makeGetRequest('/fee');
            }
            catch (err) {
                Logger_1.logger.log('Failed to update fee info: ' + err.toString(), Logger_1.LogLevel.INFO, [Logger_1.LogCategory.DAEMON]);
                return;
            }
            if (feeInfo.address === '') {
                return;
            }
            const integratedAddressesAllowed = false;
            const err = (yield ValidateParameters_1.validateAddresses(new Array(feeInfo.address), integratedAddressesAllowed, this.config)).errorCode;
            if (err !== WalletError_1.WalletErrorCode.SUCCESS) {
                Logger_1.logger.log('Failed to validate address from daemon fee info: ' + err.toString(), Logger_1.LogLevel.WARNING, [Logger_1.LogCategory.DAEMON]);
                return;
            }
            if (feeInfo.amount > 0) {
                this.feeAddress = feeInfo.address;
                this.feeAmount = feeInfo.amount;
            }
        });
    }
    makeGetRequest(endpoint) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.makeRequest(endpoint, 'GET');
        });
    }
    makePostRequest(endpoint, body) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.makeRequest(endpoint, 'POST', body);
        });
    }
    /**
     * Makes a get request to the given endpoint
     */
    makeRequest(endpoint, method, body) {
        return __awaiter(this, void 0, void 0, function* () {
            const options = {
                body,
                headers: { 'User-Agent': this.config.customUserAgentString },
                json: true,
                method,
                timeout: this.config.requestTimeout,
                resolveWithFullResponse: true,
            };
            try {
                /* Start by trying HTTPS if we haven't determined whether it's
                   HTTPS or HTTP yet. */
                const protocol = this.sslDetermined ? (this.ssl ? 'https' : 'http') : 'https';
                const url = `${protocol}://${this.host}:${this.port}${endpoint}`;
                Logger_1.logger.log(`Making request to ${url} with params ${body ? JSON.stringify(body) : '{}'}`, Logger_1.LogLevel.TRACE, [Logger_1.LogCategory.DAEMON]);
                const response = yield request(Object.assign(Object.assign(Object.assign({ agent: protocol === 'https' ? this.httpsAgent : this.httpAgent }, options), this.config.customRequestOptions), { url }));
                /* Cool, https works. Store for later. */
                if (!this.sslDetermined) {
                    this.ssl = true;
                    this.sslDetermined = true;
                }
                if (!this.connected) {
                    this.emit('connect');
                    this.connected = true;
                }
                Logger_1.logger.log(`Got response from ${url} with body ${JSON.stringify(response.body)}`, Logger_1.LogLevel.TRACE, [Logger_1.LogCategory.DAEMON]);
                return [response.body, response.statusCode];
            }
            catch (err) {
                /* No point trying again with SSL - we already have decided what
                   type it is. */
                if (this.sslDetermined) {
                    if (this.connected) {
                        this.emit('disconnect', err);
                        this.connected = false;
                    }
                    throw err;
                }
                try {
                    /* Lets try HTTP now. */
                    const url = `http://${this.host}:${this.port}${endpoint}`;
                    Logger_1.logger.log(`Making request to ${url} with params ${body ? JSON.stringify(body) : '{}'}`, Logger_1.LogLevel.TRACE, [Logger_1.LogCategory.DAEMON]);
                    const response = yield request(Object.assign(Object.assign({ agent: this.httpAgent }, options), { 
                        /* Lets try HTTP now. */
                        url }));
                    this.ssl = false;
                    this.sslDetermined = true;
                    if (!this.connected) {
                        this.emit('connect');
                        this.connected = true;
                    }
                    Logger_1.logger.log(`Got response from ${url} with body ${JSON.stringify(response.body)}`, Logger_1.LogLevel.TRACE, [Logger_1.LogCategory.DAEMON]);
                    return [response.body, response.statusCode];
                }
                catch (err) {
                    if (this.connected) {
                        this.emit('disconnect', err);
                        this.connected = false;
                    }
                    throw err;
                }
            }
        });
    }
}
exports.Daemon = Daemon;
