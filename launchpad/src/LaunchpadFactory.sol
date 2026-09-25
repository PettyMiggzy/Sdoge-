// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchpadHook} from "./LaunchpadHook.sol";
import {MemeVault} from "./MemeVault.sol";

/// Launches a token in one transaction: the token, its MemeVault, its pool, and the token's whole
/// supply as ONE single-sided position from (almost) MIN_TICK up to the launch price.
///
/// There is no bonding-curve contract and no graduation. Constant liquidity over that range IS a
/// constant-product curve with VIRTUAL_USDC of virtual USDC on the money side. The position belongs
/// to this factory, which has no function that removes or collects it, so the liquidity is locked
/// forever by construction.
///
/// Admin (an Ownable2Step owner, meant to be the Treasury multisig) can only change the launch fee
/// (bounded) and where platform fees go, and pay out the platform's fees. It cannot touch pools,
/// tokens, vaults or anyone's funds.
contract LaunchpadFactory is IUnlockCallback, Ownable2Step, ReentrancyGuardTransient {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    address public constant USDC = 0x3600000000000000000000000000000000000000;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    // In the pool, USDC is the 6-decimal ERC-20 view, so this is $5,000: the starting valuation.
    uint256 public constant VIRTUAL_USDC = 5_000e6;
    int24 public constant TICK_SPACING = 60;

    // launchFee is paid as NATIVE USDC (msg.value), which has 18 decimals on Arc: 1e18 = 1 USDC.
    // The bounds catch a fee accidentally set in 6-decimal units (2e6 would be 0.000000000002 USDC).
    uint256 public constant MAX_LAUNCH_FEE = 100e18;
    uint256 public constant MIN_NONZERO_LAUNCH_FEE = 0.01e18;

    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_SYMBOL_BYTES = 10;
    uint256 public constant MAX_URI_BYTES = 256;

    IPoolManager public immutable poolManager;
    LaunchpadHook public immutable hook;
    int24 public immutable startTick;
    int24 public immutable lowerTick;
    uint160 public immutable startSqrtPriceX96;
    uint128 public immutable launchLiquidity;

    address public feeRecipient;
    uint256 public launchFee = 2e18;

    struct Launch {
        address token;
        address vault;
        address creator;
        PoolId poolId;
    }

    Launch[] private _launches;
    mapping(address token => uint256) private _indexPlusOne;

    event Launched(
        uint256 indexed index,
        PoolId indexed poolId,
        address token,
        address vault,
        address creator,
        string name,
        string symbol,
        string uri
    );
    event LaunchFeeSet(uint256 oldFee, uint256 newFee);
    event FeeRecipientSet(address indexed oldRecipient, address indexed newRecipient);
    event LaunchFeesWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error NotPoolManager();
    error WrongLaunchFee(uint256 sent, uint256 required);
    error LaunchFeeOutOfRange(uint256 fee);
    error BadName();
    error BadSymbol();
    error BadUri();
    error UnexpectedDelta();
    error UnknownToken();
    error RenounceDisabled();

    /// Deploys the hook too, at `hookSalt`, which must be mined (see script/Deploy.s.sol) so the
    /// hook's address carries its permission flags. BaseHook's constructor rejects a wrong address.
    constructor(IPoolManager poolManager_, address owner_, address feeRecipient_, bytes32 hookSalt) Ownable(owner_) {
        if (address(poolManager_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        feeRecipient = feeRecipient_;
        hook = new LaunchpadHook{salt: hookSalt}(poolManager_);

        // price = token-wei per USDC unit = SUPPLY / VIRTUAL_USDC; sqrtPriceX96 = sqrt(price) * 2^96
        uint160 target = uint160(Math.sqrt((SUPPLY << 96) / VIRTUAL_USDC) << 48);
        int24 tick = _nearestUsableTick(TickMath.getTickAtSqrtPrice(target));
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(tick);
        int24 lower = _ceilToSpacing(TickMath.MIN_TICK);
        startTick = tick;
        lowerTick = lower;
        startSqrtPriceX96 = sqrtStart; // the price sits exactly on the position's upper bound: all token, no USDC
        launchLiquidity = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lower), sqrtStart, SUPPLY);

        emit FeeRecipientSet(address(0), feeRecipient_);
        emit LaunchFeeSet(0, launchFee);
    }

    // ------------------------------------------------------------------ launch

    /// msg.value must equal launchFee exactly (native USDC, 18 decimals). The caller becomes the
    /// token's creator and earns its creator fees. Name: 1-32 printable ASCII characters. Symbol:
    /// 1-10 letters or digits. URI: up to 256 printable ASCII characters with no spaces.
    function launch(string calldata name, string calldata symbol, string calldata uri)
        external
        payable
        nonReentrant
        returns (address tokenAddr, address vaultAddr, PoolId id)
    {
        if (msg.value != launchFee) revert WrongLaunchFee(msg.value, launchFee);
        if (!_printable(bytes(name), 1, MAX_NAME_BYTES, 0x20)) revert BadName();
        if (!_alphanumeric(bytes(symbol))) revert BadSymbol();
        if (!_printable(bytes(uri), 0, MAX_URI_BYTES, 0x21)) revert BadUri();

        LaunchToken token = _deployToken(name, symbol);
        MemeVault vault = new MemeVault(poolManager, token);
        PoolKey memory key = _key(address(token));
        id = key.toId();

        hook.register(key, msg.sender, address(vault));
        poolManager.initialize(key, startSqrtPriceX96);
        poolManager.unlock(abi.encode(key));

        uint256 dust = token.balanceOf(address(this)); // the liquidity math rounds; burn the leftover wei
        if (dust > 0) token.burn(dust);

        _launches.push(Launch(address(token), address(vault), msg.sender, id));
        _indexPlusOne[address(token)] = _launches.length;
        emit Launched(_launches.length - 1, id, address(token), address(vault), msg.sender, name, symbol, uri);
        return (address(token), address(vault), id);
    }

    /// Only reachable through launch()'s poolManager.unlock(): deposits the whole supply.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        PoolKey memory key = abi.decode(data, (PoolKey));
        (BalanceDelta d,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lowerTick,
                tickUpper: startTick,
                liquidityDelta: int256(uint256(launchLiquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        // The price sits on the upper bound, so the position is all token and needs no USDC.
        if (d.amount0() != 0 || d.amount1() >= 0) revert UnexpectedDelta();
        poolManager.sync(key.currency1);
        IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(poolManager), uint256(uint128(-d.amount1())));
        poolManager.settle();
        return "";
    }

    // ------------------------------------------------------------------ admin

    function setLaunchFee(uint256 newFee) external onlyOwner {
        if (newFee != 0 && (newFee < MIN_NONZERO_LAUNCH_FEE || newFee > MAX_LAUNCH_FEE)) {
            revert LaunchFeeOutOfRange(newFee);
        }
        emit LaunchFeeSet(launchFee, newFee);
        launchFee = newFee;
    }

    /// Where launch fees and the hook's platform fees are paid. Takes effect for everything not
    /// yet paid out.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientSet(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// Sends the collected launch fees to feeRecipient. Owner only, so a recipient being rotated
    /// out (say, a leaked key) can't be raced. Paid through the ERC-20 view of USDC, which moves
    /// the same native balance but runs no code at the recipient, so a recipient contract without
    /// a payable receive() (a fee splitter) still gets paid.
    function withdrawLaunchFees() external onlyOwner nonReentrant returns (uint256 amount) {
        amount = IERC20(USDC).balanceOf(address(this));
        if (amount == 0) return 0;
        address to = feeRecipient;
        IERC20(USDC).safeTransfer(to, amount);
        emit LaunchFeesWithdrawn(to, amount);
    }

    /// Without an owner, the fee and recipient could never change again.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------ views

    function launchCount() external view returns (uint256) {
        return _launches.length;
    }

    function launchAt(uint256 index) external view returns (Launch memory) {
        return _launches[index];
    }

    function launchOf(address token) external view returns (Launch memory) {
        uint256 i = _indexPlusOne[token];
        if (i == 0) revert UnknownToken();
        return _launches[i - 1];
    }

    function poolKeyOf(address token) external view returns (PoolKey memory) {
        if (_indexPlusOne[token] == 0) revert UnknownToken();
        return _key(token);
    }

    // ------------------------------------------------------------------ internals

    function _key(address token) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(USDC),
            currency1: Currency.wrap(token),
            fee: 0, // the hook charges the fee
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    // v4 orders a pool's currencies by address, and the hook needs USDC to be currency0. A token
    // deployed at a random address would sort below USDC about 1 time in 5, so mine a CREATE2 salt
    // that puts it above (1.27 tries on average).
    function _deployToken(string calldata name, string calldata symbol) private returns (LaunchToken) {
        bytes32 initHash = keccak256(abi.encodePacked(type(LaunchToken).creationCode, abi.encode(name, symbol, SUPPLY)));
        bytes32 salt = keccak256(abi.encode(msg.sender, _launches.length));
        while (Create2.computeAddress(salt, initHash) <= USDC) {
            salt = keccak256(abi.encode(salt));
        }
        return new LaunchToken{salt: salt}(name, symbol, SUPPLY);
    }

    function _printable(bytes calldata s, uint256 minLen, uint256 maxLen, bytes1 lowest) private pure returns (bool) {
        if (s.length < minLen || s.length > maxLen) return false;
        for (uint256 i; i < s.length; ++i) {
            if (s[i] < lowest || s[i] > 0x7e) return false;
        }
        return true;
    }

    function _alphanumeric(bytes calldata s) private pure returns (bool) {
        if (s.length == 0 || s.length > MAX_SYMBOL_BYTES) return false;
        for (uint256 i; i < s.length; ++i) {
            bytes1 c = s[i];
            if (!((c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z"))) return false;
        }
        return true;
    }

    // Rounds to the nearest multiple of TICK_SPACING: 398390 -> 398400, a $4,995.40 start instead
    // of $5,025.49 from always rounding down.
    function _nearestUsableTick(int24 t) private pure returns (int24) {
        int24 down = _floorToSpacing(t);
        return (t - down) * 2 >= TICK_SPACING ? down + TICK_SPACING : down;
    }

    function _floorToSpacing(int24 t) private pure returns (int24) {
        int24 c = t / TICK_SPACING;
        if (t < 0 && c * TICK_SPACING != t) c--;
        return c * TICK_SPACING;
    }

    function _ceilToSpacing(int24 t) private pure returns (int24) {
        int24 c = t / TICK_SPACING;
        if (t > 0 && c * TICK_SPACING != t) c++;
        return c * TICK_SPACING;
    }
}
