const TimeDelayedOrderBookMock = artifacts.require('TimeDelayedOrderBookMock')
const Erc20Token = artifacts.require('TestErc20')
const BN = require('bn.js')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ETH_TOKEN_IDENTIFIER = '0x0000000000000000000000000000000000000000'

// TODO: put in an external file.
const getLog = (receipt, logName, argName) => {
    const log = receipt.logs.find(({ event }) => event == logName)
    return log ? log.args[argName] : null
}

const assertEqualBN = async (actualPromise, expected, message) =>
    assert.equal((await actualPromise).toNumber(), expected, message)

const assertLogs = async (receiptPromise, ...logNames) => {
    const receipt = await receiptPromise
    for (const logName of logNames) {
        assert.isNotNull(getLog(receipt, logName), `Expected ${logName} in receipt`)
    }
}

const assertRevert = async (receiptPromise, reason) => {
    try {
        await receiptPromise
    } catch (e) {
        if (reason) {
            assert.include(e.message, reason, 'Incorrect revert reason')
        }
        return
    }
    assert.fail(`Expected a revert for reason: ${reason}`)
}


contract('TimeDelayedOrderBook', ([purchaseOrderCreator, notPurchaseOrderCreator, purchaseOrderFiller, notPurchaseOrderFiller]) => {

    let timeDelayedOrderBook
    let purchaseToken, paymentToken, collateralToken

    const gasPrice = 20000000000
    const purchaseValue = 30
    const paymentValue = 20
    const collateralValue = 10

    let orderId

    beforeEach(async () => {
        timeDelayedOrderBook = await TimeDelayedOrderBookMock.new()
        purchaseToken = await Erc20Token.new()
        paymentToken = await Erc20Token.new()
        collateralToken = await Erc20Token.new()
    })

    context('createPurchaseOrder() with ETH as payment and collateral', () => {

        beforeEach(async () => {
            const createOrderReceipt = await timeDelayedOrderBook.createPurchaseOrder(
                purchaseToken.address, purchaseValue, ETH_TOKEN_IDENTIFIER, paymentValue, ETH_TOKEN_IDENTIFIER, collateralValue,
                { value: paymentValue, from: purchaseOrderCreator });

            orderId = getLog(createOrderReceipt, 'NewPurchaseOrder', 'purchaseOrderId')
        })

        it('creates a new purchase order with correct details', async () => {
            const expectedTimeToFillOrder = 0

            const purchaseOrder = await timeDelayedOrderBook.purchaseOrders(orderId)

            assert.strictEqual(purchaseOrder.purchaseOrderCreator, purchaseOrderCreator)
            assert.strictEqual(purchaseOrder.purchaseToken, purchaseToken.address)
            await assertEqualBN(purchaseOrder.purchaseValue, purchaseValue)
            assert.strictEqual(purchaseOrder.paymentToken, ETH_TOKEN_IDENTIFIER)
            await assertEqualBN(purchaseOrder.paymentValue, paymentValue)
            assert.strictEqual(purchaseOrder.collateralToken, ETH_TOKEN_IDENTIFIER)
            await assertEqualBN(purchaseOrder.collateralValue, collateralValue)
            assert.isFalse(purchaseOrder.committedTo)
            assert.strictEqual(purchaseOrder.committedFillerAddress, ZERO_ADDRESS)
            await assertEqualBN(purchaseOrder.timeToFillOrder, expectedTimeToFillOrder)
        })

        context('cancelPurchaseOrder(uint256 _purchaseOrderId)', () => {

            it('deletes the purchase order', async () => {
                await timeDelayedOrderBook.cancelPurchaseOrder(orderId)

                const purchaseOrder = await timeDelayedOrderBook.purchaseOrders(orderId)
                assert.strictEqual(purchaseOrder.purchaseOrderCreator, ZERO_ADDRESS)
            })

            it('returns ETH', async () => {
                const orderCreatorInitialBalance = await web3.eth.getBalance(purchaseOrderCreator)
                let expectedOrderCreatorBalance = new BN(orderCreatorInitialBalance).add(new BN(paymentValue))

                const cancelReceipt = await timeDelayedOrderBook.cancelPurchaseOrder(orderId)

                expectedOrderCreatorBalance = expectedOrderCreatorBalance.sub(new BN(cancelReceipt.receipt.gasUsed).mul(new BN(gasPrice)))
                const actualOrderCreatorBalance = await web3.eth.getBalance(purchaseOrderCreator)
                assert.isTrue((new BN(actualOrderCreatorBalance)).eq(expectedOrderCreatorBalance))
            })

            it('reverts when not called by purchase order creator', async () => {
                await assertRevert(timeDelayedOrderBook.cancelPurchaseOrder(orderId, { from: notPurchaseOrderCreator }), 'ORDER_BOOK_NOT_PURCHASE_ORDER_OWNER')
            })
        })

        context('commitToPurchaseOrder(uint256 _purchaseOrderId)', () => {

            it('reverts when sending wrong amount of ETH', async() => {
                await assertRevert(timeDelayedOrderBook.commitToPurchaseOrder(orderId, { value: collateralValue - 1 }), 'ORDER_BOOK_INCORRECT_COLLATERAL')
            })

            it('reverts when committing twice to the same purchaseOrderId', async () => {
                await timeDelayedOrderBook.commitToPurchaseOrder(orderId, { value: collateralValue })
                await assertRevert(timeDelayedOrderBook.commitToPurchaseOrder(orderId, { value: collateralValue }), 'ORDER_BOOK_PURCHASE_COMMITTED_TO')
            })

            it('submits ETH collateral', async () => {
                const originalOrderBookEth = await web3.eth.getBalance(timeDelayedOrderBook.address)
                const expectedOrderBookEth = parseInt(originalOrderBookEth) + collateralValue

                await timeDelayedOrderBook.commitToPurchaseOrder(orderId, { value: collateralValue })

                const actualOrderBookEth = await web3.eth.getBalance(timeDelayedOrderBook.address)
                assert.strictEqual(actualOrderBookEth, expectedOrderBookEth.toString())
            })

            it('updates purchase order details', async () => {
                await timeDelayedOrderBook.commitToPurchaseOrder(orderId, { value: collateralValue })

                const purchaseOrder = await timeDelayedOrderBook.purchaseOrders(orderId)
                assert.isTrue(purchaseOrder.committedTo)
                assert.strictEqual(purchaseOrder.committedFillerAddress, purchaseOrderCreator)
            })
        })

        context('fillPurchaseOrder(uint256 _purchaseOrderId)', () => {

            beforeEach(async () => {
                await purchaseToken.transfer(purchaseOrderFiller, purchaseValue)
                await purchaseToken.approve(timeDelayedOrderBook.address, purchaseValue, { from: purchaseOrderFiller })
                await timeDelayedOrderBook.commitToPurchaseOrder(orderId, { value: collateralValue, from: purchaseOrderFiller })
            })

            it('reverts when not called by committed filler', async () => {
                await assertRevert(timeDelayedOrderBook.fillPurchaseOrder(orderId, { from: notPurchaseOrderFiller }), 'ORDER_BOOK_INCORRECT_ORDER_FILLER')
            })

            it('transfers the purchase token to the order creator', async () => {
                const originalPurchaserBalance = await purchaseToken.balanceOf(purchaseOrderCreator)
                const expectedPurchaserBalance = originalPurchaserBalance.add(new BN(purchaseValue))

                await timeDelayedOrderBook.fillPurchaseOrder(orderId, { from: purchaseOrderFiller })

                const actualPurchaserBalance = await purchaseToken.balanceOf(purchaseOrderCreator)
                assert.isTrue(actualPurchaserBalance.eq(expectedPurchaserBalance))
            })

            it('transfers payment and collateral back to the order fulfiller in ETH', async () => {
                const originalOrderFillerEth = await web3.eth.getBalance(purchaseOrderFiller)
                let expectedOrderFillerEth = new BN(originalOrderFillerEth).add(new BN(collateralValue)).add(new BN(paymentValue)) // Add payment

                const fillReceipt = await timeDelayedOrderBook.fillPurchaseOrder(orderId, { from: purchaseOrderFiller })

                expectedOrderFillerEth = expectedOrderFillerEth.sub(new BN(fillReceipt.receipt.gasUsed).mul(new BN(gasPrice)))
                const actualOrderFillerEth = await web3.eth.getBalance(purchaseOrderFiller)
                assert.isTrue(new BN(actualOrderFillerEth).eq(expectedOrderFillerEth))
            })

            it('deletes the purchase order', async () => {
                await timeDelayedOrderBook.fillPurchaseOrder(orderId, { from: purchaseOrderFiller })

                const purchaseOrder = await timeDelayedOrderBook.purchaseOrders(orderId)

                assert.strictEqual(purchaseOrder.committedFillerAddress, ZERO_ADDRESS)
            })
        })
    })

    context('createPurchaseOrder() with ERC20 as payment and collateral', () => {

        beforeEach(async () => {
            await paymentToken.approve(timeDelayedOrderBook.address, paymentValue)
            const createOrderReceipt = await timeDelayedOrderBook.createPurchaseOrder(
                purchaseToken.address, purchaseValue, paymentToken.address, paymentValue, collateralToken.address, collateralValue,
                { value: paymentValue, from: purchaseOrderCreator });

            orderId = getLog(createOrderReceipt, 'NewPurchaseOrder', 'purchaseOrderId')
        })

        it('receives payment token value when used with a payment token', async () => {
            await assertEqualBN(paymentToken.balanceOf(timeDelayedOrderBook.address), paymentValue)
        })

        context('cancelPurchaseOrder(uint256 _purchaseOrderId)', () => {

            it('returns payment token value', async () => {
                const orderCreatorInitialBalance = await paymentToken.balanceOf(purchaseOrderCreator)
                let expectedOrderCreatorBalance = orderCreatorInitialBalance.add(new BN(paymentValue))

                await timeDelayedOrderBook.cancelPurchaseOrder(orderId)

                const actualOrderCreatorBalance = await paymentToken.balanceOf(purchaseOrderCreator)
                assert.isTrue(actualOrderCreatorBalance.eq(expectedOrderCreatorBalance))
            })
        })

        context('commitToPurchaseOrder(uint256 _purchaseOrderId)', () => {

            it('submits ERC20 collateral', async () => {
                const originalOrderBookBalance = await collateralToken.balanceOf(timeDelayedOrderBook.address)
                const expectedOrderBookBalance = originalOrderBookBalance.add(new BN(collateralValue))
                await collateralToken.approve(timeDelayedOrderBook.address, collateralValue)

                await timeDelayedOrderBook.commitToPurchaseOrder(orderId)

                const actualOrderBookBalance = await collateralToken.balanceOf(timeDelayedOrderBook.address)
                assert.strictEqual(actualOrderBookBalance.toNumber(), expectedOrderBookBalance.toNumber())
            })
        })

        context('fillPurchaseOrder(uint256 _purchaseOrderId)', () => {

            beforeEach(async () => {
                await collateralToken.transfer(purchaseOrderFiller, collateralValue)
                await collateralToken.approve(timeDelayedOrderBook.address, collateralValue, { from: purchaseOrderFiller })

                await timeDelayedOrderBook.commitToPurchaseOrder(orderId, { from: purchaseOrderFiller })

                await purchaseToken.transfer(purchaseOrderFiller, purchaseValue)
                await purchaseToken.approve(timeDelayedOrderBook.address, purchaseValue, { from: purchaseOrderFiller })
            })

            it('transfers payment and collateral back to the order fulfiller in ERC20 tokens', async () => {
                const originalPaymentTokenBalance = await paymentToken.balanceOf(purchaseOrderFiller)
                const expectedPaymentTokenBalance = originalPaymentTokenBalance.add(new BN(paymentValue))
                const originalCollateralTokenBalance = await collateralToken.balanceOf(purchaseOrderFiller)
                const expectedCollateralTokenBalance = originalCollateralTokenBalance.add(new BN(collateralValue))

                await timeDelayedOrderBook.fillPurchaseOrder(orderId, { from: purchaseOrderFiller })

                const actualPaymentTokenBalance = await paymentToken.balanceOf(purchaseOrderFiller)
                const actualCollateralTokenBalance = await collateralToken.balanceOf(purchaseOrderFiller)
                assert.strictEqual(actualPaymentTokenBalance.toNumber(), expectedPaymentTokenBalance.toNumber())
                assert.strictEqual(actualCollateralTokenBalance.toNumber(), expectedCollateralTokenBalance.toNumber())
            })
        })
    })
})