/**
 * The arbitrage controller tries to capitalize on changes in market price between Doc and RBtc on the Sovryn amm.
 * 
 * First step is to define the amount for which we seek arbitrage. Currently hardcoded at 105$, the maximum trading amount.
 * Then, start an endless loop:
 * 1. Get the price from the amm. This returns the expected return form the Sovryn network.
 * 2. Get the price from the price feed contract. This returns the oracle price.
 * 3. Compare the prices. If the difference is >= threshold then sell arbitrage amount of liquidity of the respective currency to the amm,
 * Inform the telegram group about a successful arbitrage trade and save statistic in db
 * 
 * The swap network contract (conf.swapsImpl) need to be approved by the arbitrage wallet to spend Doc on his behalf
 * 
 * Todo2: Update amount calculation after the trading limits were released/updated.
 */

const Telegram = require('telegraf/telegram');
import C from './contract';
import U from '../util/helper';
import A from '../secrets/accounts';
import conf from '../config/config';
import abiDecoder from 'abi-decoder';
import abiSwap from "../config/abiSovrynSwapNetwork";
import db from "./db";


class Arbitrage {
    constructor() {
        this.telegramBotWatcher = new Telegram(conf.errorBotWatcherTelegramToken);
        this.amount = 0.010; //105$; see comment on top
        abiDecoder.addABI(abiSwap);
    }

    /**
     * Wrapper checking arbitrage opportunities
     * 1. Compare RBtc prices from Amm with the oracle
     * 2. If arbitrage opportunity is found: buy the tokens which are too many:
     * Doc if price(Amm) < price(PriceFeed), RBtc otherwise
     */
    async start() {
        while (true) {
            console.log("started checking prices");

            let res, arb, profit;
            let p = await this.getRBtcPrices();
            if(p[0]>0 && p[1]>0) arb = this.calcArbitrage(p[0], p[1], conf.thresholdArbitrage);
            if (arb && (arb == p[0])) {
                let convertedAmount = C.web3.utils.toWei(p[0].toString(), "Ether");
                res = await this.sendLiquidity(convertedAmount, "Doc");
            }
            else if (arb && (arb == p[1])) {
                res = await this.sendLiquidity(C.web3.utils.toWei(this.amount.toString()), "Rbtc");
            }

            if(res) profit = await this.calculateProfit(res);

            console.log("Completed checking prices at ");
            await U.wasteTime(conf.arbitrageScanInterval);
        }
    }

    /**
     * If price difference between p1 and p2 >= threshold return Min(p1,p2)
     * else return 0
     */
    calcArbitrage(p1, p2, threshold) {
        const smallerAmount = Math.min(p1, p2);
        const arbitrage = Math.abs(p1 - p2) / smallerAmount * 100;
        if (arbitrage >= threshold) {
            console.log("Arbitrage (%): "+arbitrage);
            if(smallerAmount==p1) console.log("Buy doc!")
            else console.log("Buy RBtc");

            return smallerAmount;
        }
        console.log(arbitrage+ " % price difference is too small for arbitrage");
        return;
    }

    async getRBtcPrices() {
        const amount = C.web3.utils.toWei(this.amount.toString(), "Ether");
        let rBtcPriceAmm = await this.getPriceFromAmm(C.contractSwaps, conf.testTokenRBTC, conf.docToken, amount);
        rBtcPriceAmm = C.web3.utils.fromWei(rBtcPriceAmm.toString(), "Ether");
        let rBtcPricePf = await this.getPriceFromPriceFeed(C.contractPriceFeed, conf.testTokenRBTC, conf.docToken, amount);
        rBtcPricePf = C.web3.utils.fromWei(rBtcPricePf.toString(), "Ether");
        console.log("RBtc Price amm: "+rBtcPriceAmm+", pricefeed: " + rBtcPricePf);
        return [rBtcPriceAmm, rBtcPricePf];
    }

    /**
    * Amount is based in sourceToken
    * Returns price in wei
    */
    getPriceFromPriceFeed(contract, sourceToken, destToken, amount) {
        return new Promise(async (resolve) => {
            try {
                contract.methods["queryReturn"](sourceToken, destToken, amount).call((error, result) => {
                    if (error) {
                        console.error("error loading price from " + contract._address + " for src " + sourceToken + ", dest " + destToken + " and amount: " + amount);
                        console.error(error);
                        return resolve(0);
                    }
                    resolve(result);
                });
            }
            catch (e) {
                console.error("error loading price from " + contract._address + " for src " + sourceToken + ", dest " + destToken + " and amount: " + amount);
                console.error(e);
                resolve(0)
            }
        });
    }

    /**
     * Amount is based in sourceToken
     * Price need to be retrieven in 2 steps
     * 1. Call function conversionPath on to get the conversion path
     * 2. Call rateByPath assigning the conversion path and amount to get the actual price
     * Returns price in wei
     */
    getPriceFromAmm(contract, sourceToken, destToken, amount) {
        return new Promise(async (resolve) => {
            try {
                contract.methods["conversionPath"](sourceToken, destToken).call((error, result) => {
                    if (error) {
                        console.error("error loading conversion path from " + contract._address + " for src " + sourceToken + ", dest " + destToken + " and amount: " + amount);
                        console.error(error);
                        return resolve(0);
                    }

                    contract.methods["rateByPath"](result, amount).call((err, res) => {
                        if (err) {
                            console.error("error loading conversion path from " + contract._address + " for src " + sourceToken + ", dest " + destToken + " and amount: " + amount);
                            console.error(err);
                            return resolve(0);
                        }
                        resolve(res);
                    });
                });
            }
            catch (e) {
                console.error("error loading price from " + contract._address + " for src " + sourceToken + ", dest " + destToken + " and amount: " + amount);
                console.error(e);
                resolve(0)
            }
        });
    }


    /**
     * Sending Doc or RBtc to the Amm
     * Amount in wei
     * todo: convert minReturn with web3-big-number lib
     */
    sendLiquidity(amount, currency) {
        console.log("Send " + amount + " "+currency+" to the amm");
        const sourceToken = currency=="Doc"?conf.docToken:conf.testTokenRBTC;
        const destToken = currency=="Doc"?conf.testTokenRBTC:conf.docToken;
        const contract1 = C.contractSwaps;
        const contract2 = C.wRbtcWrapper;
        const minReturn = 1; //amount / 100 * 99; //minReturn = 1 -> No assurance
        const beneficiary = A.arbitrage[0].adr;
        const affiliateAcc = "0x0000000000000000000000000000000000000000";
        const affiliateFee = 0;
        const val = currency=="Doc"? 0:amount;

        return new Promise(async (resolve) => {
            try {
                contract1.methods["conversionPath"](sourceToken, destToken).call((error, result) => {
                    if (error || !result || result.length!=3) {
                        console.error("error loading conversion path from " + contract._address + " for src " + sourceToken + ", dest " + destToken + " and amount: " + amount);
                        console.error(error);
                        return resolve();
                    }
                    
                    contract2.methods["convertByPath"](result, amount, minReturn)
                        .send({ from: beneficiary, gas: 2500000, value: val })
                        .then(async (tx) => {
                            console.log("Arbitrage tx successful");
                            return resolve(tx);
                        })
                        .catch((err) => {
                            console.error("Error on arbitrage tx ");
                            console.error(err);
                            return resolve();
                        });
                });
            }
            catch (e) {
                console.error("error loading price from " + contract1._address + " for src " + sourceToken + ", dest " + destToken + " and amount: " + amount);
                console.error(e);
                resolve()
            }
        });

    }

    async calculateProfit(txHash, btcPriceFeed){
        try {
            const receipt = await C.web3.eth.getTransactionReceipt(txHash);
            if (receipt && receipt.logs) {
                const logs = abiDecoder.decodeLogs(receipt.logs);
                const conversionEvent = (logs || []).find(log => log && log.name === "Conversion");
                // console.log(JSON.stringify(logs, null, 2));

                if (conversionEvent && conversionEvent.events) {
                    const priceFeed = Number(btcPriceFeed)/this.amount;
                    let {fromToken, toToken, fromAmount, toAmount, trader} = U.parseEventParams(conversionEvent.events);
                    let toAmountWithPFeed, trade;

                    fromAmount = Number(C.web3.utils.fromWei(fromAmount.toString(), 'ether'));
                    toAmount = Number(C.web3.utils.fromWei(toAmount.toString(), 'ether'));

                    if (fromToken.toLowerCase() === conf.testTokenRBTC.toLowerCase()) {
                        toAmountWithPFeed = Number(fromAmount) * priceFeed;
                        trade = 'sell btc';
                    } else {
                        toAmountWithPFeed = Number(fromAmount) / priceFeed;
                        trade = 'buy btc';
                    }
                    const profit = toAmount - toAmountWithPFeed;

                    console.log({trader,
                        fromToken, toToken,
                        fromAmount, toAmount,
                        profit,
                        trade
                    })

                    await db.addArbitrage({
                        adr: trader,
                        fromToken, toToken,
                        fromAmount, toAmount,
                        profit,
                        trade
                    })
                }
            }

        } catch (e) {
            console.error("Error when calculate arbitrage profit", e);
        }
    }

    /**
    * Converts RBtc to Doc on MoneyOnchain
    */
    convertOnMoc() {

    }
}

export default new Arbitrage();