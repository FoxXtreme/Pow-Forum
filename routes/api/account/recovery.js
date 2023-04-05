const router = require('express').Router()
const bodyParser = require('body-parser')
const mongoose = require('mongoose')
const bcrypt = require('bcrypt')

const recaptcha = require('../../../my_modules/captcha')
const mailgun = require('../../../my_modules/mailgun')
const accountAPI = require('../../../my_modules/accountapi')

const ForumSettings = mongoose.model("ForumSettings")
const Accounts = mongoose.model("Accounts")
const PasswordResetSessions = mongoose.model("PasswordResetSessions")

// 	/v1/account/recovery

// parse application/json
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json({limit: '5mb'}))

// Request password or username reset session.
//Only valid for 10 minutes
router.post('/', async (req, res) => {
	let response = {success: false}
	
	try {
		if(!await recaptcha.captchaV2(req.body.grecaptcharesponse, (req.headers['x-forwarded-for'] || req.connection.remoteAddress)))
			throw "Captcha failed"

		let forumTitle = (await ForumSettings.findOne({type: "title"})).value
		
		if('username' in req.body && req.body.username.length > 0){
			//Password reset request
			await accountAPI.fetchAccount(req.body.username)
			.then(async accountdata => {
				if(accountdata){
					let token = generate_token(64)
					//Generates new token per the extremely rare chance it exists
					do{
						token = generate_token(64)
					} while(await PasswordResetSessions.findById(token))
					let expiredate = new Date();
					expiredate.setMinutes(expiredate.getMinutes()+15); //add 15 minutes to expiry
					
					await new PasswordResetSessions({
						_id: token,
						uid: accountdata._id,
						expiredate,
					}).save()

					let emaildata = {
						from: `"noreply" ${process.env.MAILGUN_NOREPLY_ADDRESS}`, // sender address
						to: accountdata.email, // list of receivers
						subject: `${forumTitle} | Password Reset Request`, // Subject line
						text: `Someone has requested to reset ${accountdata.username}(id: ${accountdata._id})'s on ${process.env.FORUM_URL}` + 
						'\r\n\r\nIf this was you, please go to the following link, otherwise ignore and delete this email.' +
						'\r\nThe link is valid for 15 minutes.\r\n\r\n' +
						`${process.env.FORUM_URL}/passreset/?token=${token}` +
						'\r\n\r\n' +
						`This message was generated by ${process.env.FORUM_URL}`
					};

					if(!mailgun.isEmailCompatible(emaildata.to)) throw `Sorry, but the email provider tied to that account has recently blocked automated emails from ${forumTitle}. Please contact support for assistance.`
					
					await mailgun.SendMail(emaildata)
					
					response.success = true
				} 
				else throw {safe: 'No account with that username'}
			})
		} 
		else if('email' in req.body && req.body.email.length > 0){
			//Username retrieval request
			let usernames = await Accounts.find({email: new RegExp(`^${req.body.email}$`, 'i')})
			.then(async result => {
				if(result.length > 0){
					let usernames = ""
					for(index in result){
						usernames += result[index].username + ", "
					}
					usernames = usernames.substr(0, usernames.length - 2) //Remove extra ", "
					return usernames
				} 
				else throw {safe: "No account with that email"}
			})

			let emaildata = {
				from: `"noreply" ${process.env.MAILGUN_NOREPLY_ADDRESS}`, // sender address
				to: req.body.email, // list of receivers
				subject: `${forumTitle} | Username Recovery Request`, // Subject line
				text: `You have requested a reminder of ${forumTitle} accounts associated with this email address. Your accounts are listed below:` +
				'\r\n\r\n' +
				usernames + 
				'\r\n\r\n' +
				`This message was generated by ${process.env.FORUM_URL}`
			};

			if(!mailgun.isEmailCompatible(emaildata.to)) 
				throw `Sorry, but the email provider tied to that account has recently blocked automated emails from ${forumTitle}. Please contact support for assistance.`
							
			await mailgun.SendMail(emaildata)
			
			response.success = true
		}
	} catch(e){
		response.reason = "Server error"
		if(e.safe && e.safe.length > 0) response.reason = e.safe;
		else if(typeof e === "string") response.reason = e
		else console.warn(e)
	}
	
	res.json(response)
});

// Reset password
router.post('/passreset', async (req, res) => {
	let response = {success: false}
	
	try {
		if(!('token' in req.body)) throw {safe: 'Missing token'};
		
		if(!('password' in req.body)) throw {safe: 'Missing password'};

		var uid = 0;
		
		await PasswordResetSessions.findById(req.body.token)
		.then(async result => {
			if(result){
				let currentDate = new Date().getTime();
				let expireDate = result.expiredate.getTime()
				uid = result.uid
				
				if(currentDate > expireDate){
					await PasswordResetSessions.deleteOne({_id: req.body.token})
					throw {safe: "Expired token"}
				}
			} 
			else throw {safe: "Invalid token"}
		})
		
		let password = req.body.password
		
		let validatePassword = accountAPI.ValidatePassword(password)
		if(validatePassword !== true) throw validatePassword

		let securePassword = await bcrypt.hash(password, 10)
		
		//Update password
		await Accounts.updateOne({_id: uid}, {password: securePassword})
		
		//Delete token so can't reset with it anymore
		await PasswordResetSessions.deleteOne({uid, _id: req.body.token})
		
		//No early exit, so report success
		response.success = true
	} 
	catch(e){
		response.reason = "Server error"
		if(e.safe && e.safe.length > 0) response.reason = e.safe;
		else if(typeof e === "string") response.reason = e
		else console.warn(e)
	}
	
	res.json(response)
});

//Creates a random string as long as the specified length
function generate_token(length){
    //edit the token allowed characters
    var a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890_".split("");
    var b = [];  
    for (var i=0; i<length; i++) {
        var j = (Math.random() * (a.length-1)).toFixed(0);
        b[i] = a[j];
    }
    return b.join("");
}

module.exports = router;