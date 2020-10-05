/**
 * Contract position scanner
 * Reads all open positions from the blockchain by quereing "active loans" in a loop. Stores open positions in a queue "positions" and
 * positions flagged for liquidation in "liquidations".
 * Monitors every position on the loantoken contract and checks if it is still open and if it needs to be liquidated or not.
 * 
 */
import C from './contract';
import U from '../util/helper';

class PositionScanner {
    /**
     * Start processing active positions and liquidation
     */
    async start(conf, positions, liquidations) {
        this.conf=conf;
        this.positions=positions;
        this.liquidations=liquidations;
        this.processPositions();
    }

    /**
     * Start endless loop by loading all open positions from the contract until the end is reached, then start from scratch
     * It is necessary to re-read from position 0 on every run because the position of open positions can change on the contract.
     * Poosible optimization: parse the event logs after reaching current state instead of quering "getActiveLoans".
     * 
     * The performance of this overhead need to be tested and optimized if needed
     * Known issues: new open positions can have a different LoanId after some blocks got mined
     */
    async processPositions() {
        console.log("Start processing active positions");

        let from = 0;
        let to = this.conf.nrOfProcessingPositions;

        while (true) {
            const pos = await this.loadActivePositions(from, to);
            if (pos) {
                this.addPosition(pos);
                //console.log(pos.length + " active positions found");
            }

            if (pos.length > 0) {
                from = to;
                to = from + this.conf.nrOfProcessingPositions;
                await U.wasteTime(1);
            }
            //reached current state
            else {
                console.log(Object.keys(this.positions).length+" active positions found");
                
                await U.wasteTime(this.conf.waitBetweenRounds);
                from = 0;
                to = this.conf.nrOfProcessingPositions;
                
                for (let k in this.positions) if (this.positions.hasOwnProperty(k)) delete this.positions[k];
            }
        }
    }

    /**
     * Loading active positions from the contract
     * check order (0-10 = first 10 or last 10??)
     */
    loadActivePositions(from, to) {
        //console.log("loading active positions from id " + from + " to " + to);

        return new Promise(resolve => {
            try {
                C.contractSovryn.methods.getActiveLoans(from, to, false).call((error, res) => {
                    if (error) {
                        console.error("error receiving user loans");
                        console.error(error);
                        return resolve();
                    }
                    resolve(res)
                });
            }
            catch (e) {
                console.error("error on retrieving active loans");
                console.error(e);
                resolve(false);
            }
        });
    }

    /**
     * Adding new positions to the positions queue, 
     * positions ready for liquidation to the liquidations queue
     */
    addPosition(loans) {
        for (let l of loans) {
            if (!l.loanId) continue;

            if (!this.positions[l.loanId]) {
                this.positions[l.loanId] = l;

                if (l.maxLiquidatable > 0) this.liquidations[l.loanId] = l;
            }
        }
    }

}

export default new PositionScanner();